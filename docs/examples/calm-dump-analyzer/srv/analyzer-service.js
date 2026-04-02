/**
 * CALM Dump Analyzer — CAP Service Implementation.
 *
 * Receives SAP Cloud ALM event payload, constructs a prompt,
 * calls cloud-llm-hub for ABAP dump analysis, returns structured result.
 */

const cds = require('@sap/cds');

// Configuration from environment (set via mta.yaml / .mtaext)
const LLM_HUB_URL = process.env.CLOUD_LLM_HUB_URL || '';
const LLM_HUB_DESTINATION = process.env.CLOUD_LLM_HUB_DESTINATION || '';
const SAP_DESTINATION = process.env.SAP_DESTINATION || '';

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
        const analysis = await this._callLlmHub(prompt, req);

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
      llmHubUrl: LLM_HUB_URL || `destination:${LLM_HUB_DESTINATION}`,
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
   */
  _buildPrompt(parsed) {
    return [
      `Analyze ABAP dump in system ${parsed.system}:`,
      `- Program: ${parsed.program}`,
      `- Runtime Error: ${parsed.error}`,
      `- Exception: ${parsed.exception}`,
      `- Message: ${parsed.message}`,
      `- User: ${parsed.user}`,
      `- Timestamp: ${parsed.timestamp}`,
      '',
      'Use MCP tools to read the dump details and source code if available.',
      '',
      'Return your analysis as a JSON object (no markdown, raw JSON only) with this structure:',
      '{',
      '  "rootCause": "explanation of why this error happened",',
      '  "codeSection": "description of the relevant code area",',
      '  "severity": "low|medium|high|critical",',
      '  "recommendations": [',
      '    { "type": "fix|investigate|oss_note", "description": "what to do" }',
      '  ]',
      '}',
    ].join('\n');
  }

  /**
   * Call cloud-llm-hub and extract JSON from LLM response.
   *
   * Supports two modes:
   * - Direct URL (CLOUD_LLM_HUB_URL) — for development or cross-subaccount
   * - BTP Destination (CLOUD_LLM_HUB_DESTINATION) — for production on same BTP
   */
  async _callLlmHub(prompt, req) {
    const headers = { 'Content-Type': 'application/json' };
    if (SAP_DESTINATION) {
      headers['x-sap-destination'] = SAP_DESTINATION;
    }

    const body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
    });

    let responseData;

    if (LLM_HUB_DESTINATION) {
      // Production: call via BTP Destination (auto-resolves URL + auth)
      const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
      const response = await executeHttpRequest(
        { destinationName: LLM_HUB_DESTINATION },
        { method: 'POST', url: '/v1/chat/completions', headers, data: body },
      );
      responseData = response.data;
    } else if (LLM_HUB_URL) {
      // Development: call via direct URL
      const token = req.headers?.authorization || '';
      if (token) headers['Authorization'] = token;

      const response = await fetch(`${LLM_HUB_URL}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body,
      });
      if (!response.ok) {
        throw new Error(`cloud-llm-hub returned ${response.status}`);
      }
      responseData = await response.json();
    } else {
      throw new Error(
        'CLOUD_LLM_HUB_URL or CLOUD_LLM_HUB_DESTINATION must be configured',
      );
    }

    const content = responseData.choices?.[0]?.message?.content || '';

    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = content.match(/```json?\s*([\s\S]*?)```/);
    try {
      return JSON.parse(jsonMatch ? jsonMatch[1].trim() : content.trim());
    } catch {
      return {
        rootCause: content,
        codeSection: '',
        severity: 'unknown',
        recommendations: [],
      };
    }
  }
};
