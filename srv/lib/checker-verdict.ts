import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  DialogueState,
  ILlm,
  ISubAgent,
  ISubAgentResult,
  RagCaller,
} from '@mcp-abap-adt/llm-agent';
import {
  formatTrustTag,
  OrchestratorError,
  RagAccessDeniedError,
} from '@mcp-abap-adt/llm-agent';
import { profileToolAllowed } from '../request-session';
import type { CheckerSource, EvidenceProvenance } from './checker-source';
import {
  type CheckerClaim,
  type CheckerVerdict,
  checkerClaimsSchema,
  verdictSchema,
} from './checker-verdict-schema';
import { submitVerdictTool } from './checker-verdict-tool';
import { safeContextExceeded } from './llm-failure';
import {
  type JournalEntry,
  type JournalTarget,
  journalOutcome,
  journalPayload,
  journalTargets,
} from './tool-journal';

interface CheckerBrief {
  claims: string;
  journal: ReadonlyMap<string, JournalEntry>;
}

const briefScope = new AsyncLocalStorage<CheckerBrief>();
export function withCheckerBrief<T>(brief: CheckerBrief, run: () => T): T {
  return briefScope.run(brief, run);
}

interface ClaimEvidence {
  issue?: string;
  content?: object | string | number | boolean | null;
  provenance?: string;
  operation?: string;
  arguments?: JournalEntry['call']['arguments'];
  outcome?: ReturnType<typeof journalOutcome>;
}

const unusableVerdictPrefix = 'unusable verdict: ';
const unusableVerdict = (reason: string) => unusableVerdictPrefix + reason;

interface CheckerResult extends ISubAgentResult {
  metadata?: {
    model?: string;
    verdictError?: 'UNPARSABLE_VERDICT' | 'VERDICT_RETRIEVAL_FAILED';
  };
}

function sameTarget(
  target: CheckerClaim['target'],
  observed: JournalTarget,
): boolean {
  if ('type' in target)
    return (
      'type' in observed &&
      target.type === observed.type &&
      target.name.toUpperCase() === observed.name.toUpperCase()
    );
  return (
    'scope' in observed &&
    target.scope === observed.scope &&
    target.collection === observed.collection &&
    ('record' in target ? target.record : undefined) === observed.record
  );
}

type ReadSource = (
  caller: RagCaller,
  target: Extract<CheckerClaim, { system: 'source' }>['target'],
  recordId: string,
) => Promise<CheckerSource | undefined>;

type JournalProvenance = (
  caller: RagCaller,
  entry: JournalEntry,
  target: JournalTarget,
) => EvidenceProvenance | undefined | Promise<EvidenceProvenance | undefined>;

async function citedEvidence(
  claim: CheckerClaim,
  journal: ReadonlyMap<string, JournalEntry>,
  read: (
    target: Parameters<ReadSource>[1],
    id: string,
  ) => Promise<CheckerSource | undefined>,
  journalProvenance: (
    entry: JournalEntry,
    target: JournalTarget,
  ) => ReturnType<JournalProvenance>,
): Promise<ClaimEvidence> {
  const { callId, recordId, quote } = claim.evidence;
  if (claim.system === 'source') {
    if (!recordId || !quote || callId)
      return { issue: 'Source citation requires a record id and exact quote.' };
    const source = await read(claim.target, recordId);
    if (!source)
      return {
        issue: 'The cited record is unavailable at the claimed target.',
      };
    if (!source.text.includes(quote))
      return { issue: 'The quote is absent from the cited record.' };
    return {
      content: source.text,
      provenance:
        source.provenance &&
        formatTrustTag(source.provenance.source, source.provenance.trust),
    };
  }
  if (!callId || recordId)
    return {
      issue:
        'The write citation is missing a journal call id or includes a record id.',
    };
  const entry = journal.get(callId);
  if (!entry)
    return { issue: 'The cited call is absent from the current journal.' };
  if (entry.system !== claim.system)
    return { issue: 'The cited call belongs to a different system.' };
  if (!entry.write)
    return { issue: 'The cited call is a read and cannot prove a write.' };
  const target = journalTargets(entry).find((target) =>
    sameTarget(claim.target, target),
  );
  if (!target)
    return { issue: 'The cited call does not identify the claimed target.' };
  const outcome = journalOutcome(entry);
  if (outcome === 'unconfirmed')
    return { issue: 'The cited call is unconfirmed.' };
  const content = journalPayload(entry.result.content);
  if (
    quote &&
    !JSON.stringify(content ?? '').includes(quote) &&
    !(typeof content === 'string' && content.includes(quote))
  )
    return { issue: 'The quote is absent from the cited tool result.' };
  const provenance = await journalProvenance(entry, target);
  return {
    content,
    provenance:
      provenance && formatTrustTag(provenance.source, provenance.trust),
    operation: entry.call.name,
    arguments: entry.call.arguments,
    outcome,
  };
}

function negativeFindings(findings: CheckerVerdict['findings']): string {
  return findings
    .filter(({ status }) => status !== 'confirmed')
    .map(
      ({ claim, status, evidence, reason }) =>
        `"${claim}" ${status} (${evidence.callId ?? evidence.recordId ?? 'citation missing'}). ${reason}`,
    )
    .join('\n');
}

/** Adapt checker results to the adaptive interpreter's branch reasons. */
export function adaptiveCheckerOutput(result: ISubAgentResult): string {
  const { output, metadata, usage } = result;
  const code = metadata?.verdictError;
  if (code === 'VERDICT_RETRIEVAL_FAILED')
    throw Object.assign(new OrchestratorError(output, code), { usage });
  if (code === 'UNPARSABLE_VERDICT')
    return JSON.stringify({ verdict: 'partial', reason: output });
  try {
    const verdict = verdictSchema.safeParse(JSON.parse(output));
    if (verdict.success && verdict.data.verdict === 'fail')
      return JSON.stringify({
        ...verdict.data,
        reason: negativeFindings(verdict.data.findings),
      });
  } catch {
    // The interpreter handles malformed output.
  }
  return output;
}

function boundVerdict(
  verdict: CheckerVerdict,
  claims: readonly CheckerClaim[],
  evidence: readonly ClaimEvidence[],
): boolean {
  return (
    verdict.findings.length === claims.length &&
    verdict.findings.every((finding, index) => {
      const claim = claims[index];
      const cited = evidence[index];
      return (
        finding.claim === claim.claim &&
        finding.evidence.callId === claim.evidence.callId &&
        finding.evidence.recordId === claim.evidence.recordId &&
        finding.evidence.quote === claim.evidence.quote &&
        finding.reason.trim().length > 0 &&
        (!cited.issue || finding.status === 'unsupported') &&
        (cited.outcome !== 'failed' || finding.status !== 'confirmed')
      );
    })
  );
}

export function createCheckerWorker(
  name: string,
  description: string,
  systemPrompt: string,
  llm: ILlm,
  readSource: ReadSource,
  journalProvenance: JournalProvenance,
): ISubAgent {
  return {
    name,
    description,
    capabilities: { contextPolicy: 'optional' },
    async run(input): Promise<CheckerResult> {
      if (
        input.sessionId !== undefined &&
        input.sessionId !== input.caller.sessionId
      )
        throw new RagAccessDeniedError(
          'Caller session does not match checker session',
        );
      if (input.stopSignal?.aborted) return { output: '', stopped: true };
      if (!profileToolAllowed(submitVerdictTool.name))
        return {
          output: unusableVerdict('profile cannot submit findings'),
          metadata: { verdictError: 'VERDICT_RETRIEVAL_FAILED' },
        };
      const brief = briefScope.getStore();
      let claims: CheckerClaim[];
      try {
        claims = checkerClaimsSchema.parse(
          JSON.parse(brief?.claims ?? input.task),
        );
      } catch {
        return {
          output: unusableVerdict('expected a JSON list of cited claims'),
          metadata: { verdictError: 'UNPARSABLE_VERDICT' },
        };
      }
      const journal = brief?.journal ?? new Map<string, JournalEntry>();
      const evidence = await Promise.all(
        claims.map((claim) =>
          citedEvidence(
            claim,
            journal,
            async (target, id) => {
              try {
                return await readSource(input.caller, target, id);
              } catch {
                input.signal?.throwIfAborted();
                return undefined;
              }
            },
            (entry, target) => journalProvenance(input.caller, entry, target),
          ),
        ),
      );
      input.signal?.throwIfAborted();
      const response = await llm
        .chat(
          [
            {
              role: 'system',
              content: [
                systemPrompt,
                'Verify only the cited evidence below. Sources establish what the record says. Use the hub source and trust tags in cited.provenance when weighing the cited content. A write requires a succeeded write call for the claimed operation and target.',
                'Submit exactly one finding per input claim, in order, through submit_verdict. Copy the claim and citation exactly. An evidence issue is unsupported. Pass requires all findings to be confirmed.',
                'For a batch check, include count as the number of distinct expected items whose results the cited evidence confirms.',
              ].join('\n'),
            },
            {
              role: 'user',
              content: JSON.stringify(
                claims.map((claim, index) => ({
                  ...claim,
                  cited: evidence[index],
                })),
              ),
            },
          ],
          [submitVerdictTool],
          {
            trace: input.trace,
            sessionId: input.sessionId,
            signal: input.signal,
            usage: input.usage?.with({ role: 'checker' }),
          },
        )
        .catch((error) => {
          const overflow = safeContextExceeded(error);
          if (overflow) throw overflow;
          return undefined;
        });
      const overflow = !response?.ok && safeContextExceeded(response?.error);
      if (overflow) throw overflow;
      if (input.stopSignal?.aborted) return { output: '', stopped: true };
      if (!response?.ok) {
        input.signal?.throwIfAborted();
        return {
          output: unusableVerdict('checker model could not submit findings'),
          metadata: { verdictError: 'VERDICT_RETRIEVAL_FAILED' },
        };
      }
      const { toolCalls, usage } = response.value;
      const call = toolCalls?.length === 1 ? toolCalls[0] : undefined;
      const parsed =
        call?.name === submitVerdictTool.name
          ? verdictSchema.safeParse(call.arguments)
          : undefined;
      if (!parsed?.success || !boundVerdict(parsed.data, claims, evidence))
        return {
          output: unusableVerdict('missing or invalid findings'),
          usage,
          metadata: { model: llm.model, verdictError: 'UNPARSABLE_VERDICT' },
        };
      const findings = parsed.data.findings.map((finding, index) => ({
        ...finding,
        reason: evidence[index].issue ?? finding.reason,
      }));
      return {
        output: JSON.stringify({ ...parsed.data, findings }),
        summary: negativeFindings(findings) || 'All cited claims confirmed.',
        usage,
        metadata: { model: llm.model },
      };
    },
  };
}

/** The library maps malformed verdicts to fail; the hub keeps them undecided. */
export function clearUnusableCheckerFailures(state: DialogueState): void {
  if (!state.plan || typeof state.plan === 'string') return;
  let cleared = false;
  for (const step of state.plan.steps) {
    const task = state.tasks.find((task) => task.id === step.workTaskId);
    if (
      step.state === 'skipped' ||
      step.verdict !== 'fail' ||
      task?.result !== 'verdict' ||
      !task.output?.startsWith(unusableVerdictPrefix)
    )
      continue;
    cleared = true;
    delete step.verdict;
    delete step.successfulWorkTaskId;
    step.state = 'pending';
    step.note = task.output;
  }
  if (cleared && state.plan.status !== 'waiting_user') {
    state.plan.status = 'active';
    state.planStatus = 'active';
  }
}

/** Reopen only unusable current attempts; retain explicit coordinator skips. */
export function unusableCheckerPlanSteps(state: DialogueState) {
  clearUnusableCheckerFailures(state);
  if (
    !state.plan ||
    typeof state.plan === 'string' ||
    !state.plan.steps.some(
      (step) =>
        step.state === 'pending' &&
        step.workTaskId &&
        step.note?.startsWith(unusableVerdictPrefix),
    )
  )
    return undefined;
  return state.plan.steps.map((step) => ({
    id: step.id,
    goal: step.goal,
    worker: step.worker,
    result: step.result,
    items: step.items,
    dependsOn: step.dependsOn,
    state: step.state,
    note: step.note,
  }));
}
