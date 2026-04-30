import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
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
          content:
            'You are a senior ABAP engineer. Analyze the provided ABAP runtime error dump. ' +
            'Use available MCP tools (e.g. GetClass, GetProgram) on referenced objects when helpful. ' +
            'Respond in markdown with sections "## Diagnosis" and "## Recommendations". ' +
            'The Recommendations section MUST contain numbered, actionable steps.'
        },
        { role: 'user', content: userPrompt }
      ]
    };

    const resp = await executeHttpRequest(
      { destinationName: this.destinationName },
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'X-SAP-Destination': this.sapDestination
        },
        data: body,
        responseType: 'json'
      }
    );

    const raw = JSON.stringify(resp.data);
    const content: string = resp.data?.choices?.[0]?.message?.content ?? '';
    const recommendations = extractSection(content, 'Recommendations') ?? content;
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

function extractSection(md: string, heading: string): string | undefined {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|\\Z)`, 'mi');
  const m = re.exec(md);
  return m ? m[1].trim() : undefined;
}
