/**
 * CALM Dump Analyzer — CAP Service Implementation.
 *
 * Receives SAP Cloud ALM event payload, constructs a prompt,
 * calls cloud-llm-hub for ABAP dump analysis, returns structured result.
 */

const cds = require('@sap/cds');

// Destination CLOUD_LLM_HUB is created by mta.yaml init_data at deploy time.
// SAP_DESTINATION is the ABAP system (passed to cloud-llm-hub in x-sap-destination header).
const LLM_HUB_DESTINATION = 'CLOUD_LLM_HUB';
const SAP_DESTINATION = process.env.SAP_DESTINATION || '';

const DEFAULT_PROMPT = `Analyze ABAP dump in system {system}:
- Program: {program}
- Runtime Error: {error}
- Exception: {exception}
- Message: {message}
- User: {user}
- Timestamp: {timestamp}

Use MCP tools to read the dump details and source code if available.

IMPORTANT: Your final response must contain ONLY a valid JSON object — no text before or after it,
no markdown code blocks, no explanations, no tool execution logs.
Just the raw JSON object with this exact structure:

{"rootCause": "why this error happened (include the specific variable and code line if found)",
"codeSection": "the exact ABAP code around the error with line numbers",
"severity": "low|medium|high|critical",
"recommendations": [{"type": "fix|investigate|oss_note", "description": "actionable advice"}]}`;

module.exports = class AnalyzerService extends cds.ApplicationService {
  init() {
    const log = cds.log('analyzer');

    this.on('AnalyzeDump', async (req) => {
      const rawEvent = req.data.event;
      if (!rawEvent) {
        return { status: 'error', errorMessage: 'Missing event payload' };
      }

      let body;
      try {
        body = JSON.parse(rawEvent);
      } catch {
        return { status: 'error', errorMessage: 'Invalid JSON in event payload' };
      }

      // Parse CALM event
      const parsed = this._parseEvent(body);
      if (!parsed) {
        return { status: 'error', errorMessage: 'Invalid payload: missing startEvent' };
      }

      log.info('Analyzing dump', {
        system: parsed.system,
        program: parsed.program,
        error: parsed.error,
      });

      // Build prompt and call cloud-llm-hub
      try {
        const prompt = this._buildPrompt(parsed);
        const analysis = await this._callLlmHub(prompt);

        return {
          status: 'analyzed',
          system: parsed.system,
          program: parsed.program,
          error: parsed.error,
          exception: parsed.exception,
          user: parsed.user,
          rootCause: analysis.rootCause || '',
          codeSection: analysis.codeSection || '',
          severity: analysis.severity || 'unknown',
          recommendations: JSON.stringify(analysis.recommendations || []),
          errorMessage: '',
        };
      } catch (err) {
        log.error('Analysis failed', { error: err.message });
        return {
          status: 'error',
          system: parsed.system,
          program: parsed.program,
          error: parsed.error,
          exception: parsed.exception,
          user: parsed.user,
          rootCause: '',
          codeSection: '',
          severity: '',
          recommendations: '[]',
          errorMessage: err.message,
        };
      }
    });

    this.on('Health', () => ({
      status: 'ok',
      llmHub: `destination:${LLM_HUB_DESTINATION}`,
      timestamp: new Date().toISOString(),
    }));

    return super.init();
  }

  /**
   * Extract key fields from CALM event payload.
   */
  _parseEvent(body) {
    const event = body?.startEvent;
    if (!event) return null;

    const table = event.eventDetailsTable;
    const cols = table?.columns || [];
    const row = table?.rows?.[0] || [];
    const col = (name) => cols.indexOf(name);

    const errorField = row[col('Runtime Error~Exception')] || '';
    const [error, exception] = errorField.split('~');

    return {
      system: event.serviceName || '',
      program: row[col('Program')] || '',
      error: error || '',
      exception: exception || '',
      message: row[col('Message')] || '',
      user: row[col('User')] || '',
      timestamp: row[col('Timestamp')] || event.timestamp || '',
    };
  }

  /**
   * Build analysis prompt from parsed event.
   * Uses ANALYSIS_PROMPT env var if set, otherwise default prompt.
   * Prompt template supports placeholders: {system}, {program}, {error}, {exception}, {message}, {user}, {timestamp}
   */
  _buildPrompt(parsed) {
    const template = process.env.ANALYSIS_PROMPT || DEFAULT_PROMPT;
    return template
      .replace(/\{system\}/g, parsed.system)
      .replace(/\{program\}/g, parsed.program)
      .replace(/\{error\}/g, parsed.error)
      .replace(/\{exception\}/g, parsed.exception)
      .replace(/\{message\}/g, parsed.message)
      .replace(/\{user\}/g, parsed.user)
      .replace(/\{timestamp\}/g, parsed.timestamp);
  }

  /**
   * Call cloud-llm-hub via BTP Destination and extract JSON from LLM response.
   * Destination CLOUD_LLM_HUB is created at deploy time by mta.yaml init_data.
   */
  async _callLlmHub(prompt) {
    const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

    const headers = { 'Content-Type': 'application/json' };
    if (SAP_DESTINATION) {
      headers['x-sap-destination'] = SAP_DESTINATION;
    }

    const response = await executeHttpRequest(
      { destinationName: LLM_HUB_DESTINATION },
      {
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        data: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: 'You are an ABAP dump analysis service. You MUST respond with ONLY a raw JSON object. No markdown, no code blocks, no explanations, no text before or after the JSON. Your entire response must be parseable by JSON.parse().',
            },
            { role: 'user', content: prompt },
          ],
        }),
      },
      // Third argument: disable CSRF token fetch — cloud-llm-hub is REST, not OData
      { fetchCsrfToken: false },
    );

    const responseData = response.data;

    const content = responseData.choices?.[0]?.message?.content || '';

    return this._extractJson(content);
  }

  /**
   * Extract JSON from LLM response. Handles:
   * - Raw JSON
   * - JSON in markdown code block
   * - JSON preceded by tool execution logs ([SmartAgent: ...])
   * - JSON embedded in mixed text
   */
  _extractJson(content) {
    const fallback = {
      rootCause: content.replace(/\[SmartAgent:[^\]]*\]/g, '').trim(),
      codeSection: '',
      severity: 'unknown',
      recommendations: [],
    };

    if (!content) return fallback;

    // Try 1: markdown code block
    const mdMatch = content.match(/```json?\s*([\s\S]*?)```/);
    if (mdMatch) {
      try { return JSON.parse(mdMatch[1].trim()); } catch { /* fall through */ }
    }

    // Try 2: find first { ... } with matching braces
    const braceStart = content.indexOf('{');
    if (braceStart >= 0) {
      let depth = 0;
      for (let i = braceStart; i < content.length; i++) {
        if (content[i] === '{') depth++;
        if (content[i] === '}') depth--;
        if (depth === 0) {
          try {
            return JSON.parse(content.substring(braceStart, i + 1));
          } catch { /* fall through */ }
          break;
        }
      }
    }

    // Try 3: raw content as JSON
    try { return JSON.parse(content.trim()); } catch { /* fall through */ }

    return fallback;
  }
};
