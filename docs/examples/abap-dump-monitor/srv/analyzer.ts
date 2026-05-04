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
    const temperature = Number.parseFloat((await this.settings.get('LLM_TEMPERATURE')) ?? '0.2');

    const userPrompt = buildPrompt(parsed);
    const body = {
      model,
      temperature,
      stream: false,
      messages: [
        {
          role: 'system',
          content: [
            'You are an automated ABAP dump-triage formatter. Your output is fed verbatim',
            'into a Jira ticket — there is NO human chat going on, no follow-up turn, no',
            'tools to call. Produce the issue body and stop.',
            '',
            'The response MUST be exactly four markdown sections, in this order, and',
            'NOTHING else. No preamble, no first-person narration, no tool announcements,',
            'no "I can see" / "Let me check" / "[SmartAgent: …]" / "Would you like me to".',
            'If you write any of those phrases, the output is rejected.',
            '',
            'Required output template (replace the bracketed text, keep the headings):',
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
    // Strip cloud-llm-hub SmartAgent traces and chat-style narration that some
    // models still inject despite the "no chat asides" rule. Keep only the
    // sectioned content: from the first "## " heading onward.
    const cleaned = stripChatNoise(content);
    const recommendations = cleaned;
    return { raw, recommendations };
  }
}

function buildPrompt(p: ParsedDump): string {
  const top5 = p.callStack.slice(0, 5).map(f => `${f.position}. ${f.eventType ?? ''} ${f.eventName ?? ''} @ ${f.program}/${f.include}:${f.line}`).join('\n');
  return [
    `# ABAP Dump`,
    `System: ${p.header.system}  Client: ${p.header.client ?? ''}  User: ${p.header.abapUser ?? ''}`,
    `Runtime error: ${p.header.runtimeError ?? ''}`,
    `Exception: ${p.header.exceptionClass ?? ''}`,
    `Location: ${p.header.program}/${p.header.include}:${p.header.sourceLine}`,
    `Short text: ${p.header.shortText ?? ''}`,
    ``,
    `## Top stack`,
    top5,
    ``,
    `## Source extract`,
    '```abap',
    p.sourceExtract?.code ?? '(none)',
    '```',
    ``,
    `## Variables`,
    p.variables.slice(0, 20).map(v => `- [${v.scope}] ${v.name} : ${v.type ?? ''} = ${v.value ?? ''}`).join('\n')
  ].join('\n');
}

function stripChatNoise(md: string): string {
  if (!md) return md;
  let s = md;
  // Drop cloud-llm-hub SmartAgent traces (single line and multi-line).
  s = s.replace(/^\s*\[SmartAgent:[^\]]*\]\s*$/gm, '');
  s = s.replace(/^\s*\[Tool[^\]]*\]\s*$/gm, '');
  s = s.replace(/^\s*Let me [^\n]+\n/gm, '');
  s = s.replace(/^\s*I (?:can see|will|need to|notice|am going to)[^\n]+\n/gm, '');
  s = s.replace(/^\s*Would you like[^\n]+\n/gm, '');
  // Trim everything before the first "## " heading.
  const i = s.indexOf('## ');
  if (i > 0) s = s.slice(i);
  // Collapse 3+ blank lines.
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function extractSection(md: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi');
  const m = re.exec(md);
  return m ? m[1].trim() : undefined;
}
