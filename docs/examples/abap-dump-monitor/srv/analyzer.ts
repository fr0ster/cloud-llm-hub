import { getDestination } from '@sap-cloud-sdk/connectivity';
import type { IAnalyzer, ISettings, ParsedDump, AnalysisResult } from './interfaces';

export class Analyzer implements IAnalyzer {
  constructor(
    private destinationName: string,
    private sapDestination: string,
    private settings: ISettings
  ) {}

  async analyze(parsed: ParsedDump): Promise<AnalysisResult> {
    const model = (await this.settings.get('LLM_MODEL')) ?? 'anthropic--claude-4.5-sonnet';
    const temperature = Number.parseFloat((await this.settings.get('LLM_TEMPERATURE')) ?? '0');

    const userPrompt = buildPrompt(parsed);
    const body = {
      model,
      temperature,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            'This is NOT a conversation. There is no user on the other end. Your single',
            'response is taken as-is and posted as the body of a Jira incident ticket for',
            'an ABAP runtime dump. The reader is the assigned developer reading the ticket',
            'after the fact — they cannot reply, ask follow-up questions, or accept offers',
            'of further help. There will be no second turn.',
            '',
            'OUTPUT CONTRACT — these are hard requirements, not suggestions:',
            '* Your response begins with the literal characters "## Location" — no leading',
            '  H1 title, no preamble paragraph, no "Analysis of…" cover heading.',
            '* The response contains EXACTLY four "## " headings, in this order, spelled',
            '  exactly: "## Location", "## Cause", "## Investigation", "## Fix". No other',
            '  H2/H3 headings (no "## Problem Summary", "## Root Cause", "## Why", "## Next',
            '  Steps", "## Recommended Solutions", "## Recommendations", etc.).',
            '* The response ends with the last line of the "## Fix" section — no trailing',
            '  questions, no offers ("Would you like…", "Should I…", "Do you want…",',
            '  "I can also…", "Let me know…"), no closing summary.',
            '* Style: terse, factual, business — third-person impersonal, no first-person.',
            '',
            'Section contents (replace the bracketed text, keep the headings):',
            '',
            '## Location',
            '<one paragraph: program / include / method / line + the exact offending ABAP',
            'statement quoted from the dump source extract>',
            '',
            '## Cause',
            '<one paragraph: root cause grounded in actual variable values / table',
            'contents from THIS dump — quote them inline. No abstract theory.>',
            '',
            '## Investigation',
            '1. <imperative step (Inspect / Query / Trace / Reproduce / Compare / Verify …)>',
            '2. <…>',
            '',
            '## Fix',
            '1. <imperative step (Add / Replace / Initialize / Bind / Catch / Refactor …)>',
            '2. <…>',
            '',
            '```abap',
            '" minimal ABAP patch only when it speeds the fix; otherwise omit the block',
            '```',
            '',
            'Style rules:',
            '- Reference actual values from variables / source extract / call stack.',
            '- One sentence per numbered item.',
            '- Code fences only for ABAP code; no fence around the whole answer.',
            '- If a section truly has nothing to say, write a single dash "—" under it.'
          ].join('\n')
        },
        { role: 'user', content: userPrompt }
      ]
    };

    const dest = await getDestination({ destinationName: this.destinationName });
    if (!dest?.url) throw new Error(`Destination ${this.destinationName} has no URL`);
    const token = dest.authTokens?.[0]?.value;
    if (!token) throw new Error(`Destination ${this.destinationName} has no auth token`);
    const tokenType = dest.authTokens?.[0]?.type ?? 'Bearer';

    const url = new URL('/v1/chat/completions', dest.url).toString();
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `${tokenType} ${token}`,
        'Content-Type': 'application/json',
        'X-SAP-Destination': this.sapDestination
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = await resp.json() as any;
    const raw = JSON.stringify(data);
    const content: string = data?.choices?.[0]?.message?.content ?? '';
    // No code-side filtering: response shape is the prompt's contract.
    // If the model emits chat asides, fix the prompt — not regexes here.
    const recommendations = content.trim();
    return { raw, recommendations };
  }
}

function buildPrompt(p: ParsedDump): string {
  // The user message is *data*, not a structured document. Markdown headings
  // here (e.g. '## Top stack') leak into the model's output style — it mirrors
  // the input's heading structure and emits its own H2 headings ('## Problem
  // Summary', '## Root Cause') instead of the four required by the system
  // prompt. Use lowercase YAML-like labels and indented blocks; reserve '##'
  // for the response template only.
  const top5 = p.callStack.slice(0, 5)
    .map(f => `  ${f.position}. ${f.eventType ?? ''} ${f.eventName ?? ''} @ ${f.program}/${f.include}:${f.line}`)
    .join('\n');
  const vars = p.variables.slice(0, 20)
    .map(v => `  - [${v.scope}] ${v.name} = ${v.value ?? ''}`)
    .join('\n');
  return [
    `dump_data:`,
    `  system: ${p.header.system}`,
    `  client: ${p.header.client ?? ''}`,
    `  abap_user: ${p.header.abapUser ?? ''}`,
    `  runtime_error: ${p.header.runtimeError ?? ''}`,
    `  exception_class: ${p.header.exceptionClass ?? ''}`,
    `  location: ${p.header.program}/${p.header.include}:${p.header.sourceLine}`,
    `  short_text: ${p.header.shortText ?? ''}`,
    ``,
    `top_stack:`,
    top5,
    ``,
    `source_extract: |`,
    (p.sourceExtract?.code ?? '(none)').split('\n').map(l => '  ' + l).join('\n'),
    ``,
    `variables:`,
    vars,
    ``,
    `Now produce the four-section ticket body per the system prompt's contract.`
  ].join('\n');
}

function extractSection(md: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi');
  const m = re.exec(md);
  return m ? m[1].trim() : undefined;
}
