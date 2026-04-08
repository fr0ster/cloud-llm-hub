/**
 * Core analysis logic — shared between OData action and REST endpoint.
 */

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const LLM_HUB_DESTINATION = 'CLOUD_LLM_HUB';
const SAP_DESTINATION = process.env.SAP_DESTINATION || '';

const DEFAULT_PROMPT = `Analyze ABAP dump for user {user} in system {system}.
The dump occurred at {timestamp} with runtime error {error} ({exception}) in program {program}.
Message: {message}

You already have the exact datetime and user from the CALM event — do NOT search for the dump.
Call RuntimeGetDumpById once with datetime="{timestamp}" and user="{user}".
Then analyze the dump and respond.

IMPORTANT: Your final response must contain ONLY a valid JSON object — no text before or after it,
no markdown code blocks, no explanations, no tool execution logs.
Just the raw JSON object with this exact structure:

{"rootCause": "why this error happened (include the specific variable and code line if found)",
"codeSection": "the exact ABAP code around the error with line numbers",
"severity": "low|medium|high|critical",
"recommendations": [{"type": "fix|investigate|oss_note", "description": "actionable advice"}]}`;

function parseEvent(body) {
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

function buildPrompt(parsed) {
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
 * @param {string} prompt
 * @param {{ model?: string, temperature?: number }} [llmOptions]
 */
async function callLlmHub(prompt, llmOptions, destination) {
  const headers = { 'Content-Type': 'application/json' };
  const dest = destination || SAP_DESTINATION;
  if (dest) headers['x-sap-destination'] = dest;

  const response = await executeHttpRequest(
    { destinationName: LLM_HUB_DESTINATION },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      data: JSON.stringify({
        ...(llmOptions?.model ? { model: llmOptions.model } : {}),
        ...(llmOptions?.temperature != null ? { temperature: llmOptions.temperature } : {}),
        messages: [
          { role: 'system', content: 'You are an ABAP dump analysis service that outputs JSON.\nRules:\n- Your ENTIRE response is fed directly into JSON.parse(). Any non-JSON text will crash the caller.\n- Do NOT wrap output in ```json``` or any markdown.\n- Do NOT add explanations, preamble, or trailing text.\n- Output exactly one JSON object matching the schema the user provides.' },
          { role: 'user', content: prompt },
        ],
      }),
    },
    { fetchCsrfToken: false },
  );

  const content = response.data.choices?.[0]?.message?.content || '';
  return extractJson(content);
}

function extractJson(content) {
  const fallback = {
    rootCause: content.replace(/\[SmartAgent:[^\]]*\]/g, '').trim(),
    codeSection: '',
    severity: 'unknown',
    recommendations: [],
  };
  if (!content) return fallback;

  const mdMatch = content.match(/```json?\s*([\s\S]*?)```/);
  if (mdMatch) {
    try { return JSON.parse(mdMatch[1].trim()); } catch { /* fall through */ }
  }

  const braceStart = content.indexOf('{');
  if (braceStart >= 0) {
    let depth = 0;
    for (let i = braceStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') depth--;
      if (depth === 0) {
        try { return JSON.parse(content.substring(braceStart, i + 1)); } catch { /* fall through */ }
        break;
      }
    }
  }

  try { return JSON.parse(content.trim()); } catch { /* fall through */ }
  return fallback;
}

/**
 * Run full analysis: parse CALM event → build prompt → call LLM → return result.
 */
/**
 * Resolve SAP destination from system code (e.g., "E19.100" → "S4HANA_E19").
 * Uses cloud-llm-hub /v1/destinations/resolve endpoint.
 * Falls back to SAP_DESTINATION env var if resolve fails or is unavailable.
 */
async function resolveDestination(systemCode) {
  if (SAP_DESTINATION) return SAP_DESTINATION;
  if (!systemCode) return '';

  try {
    const response = await executeHttpRequest(
      { destinationName: LLM_HUB_DESTINATION },
      { method: 'GET', url: `/v1/destinations/resolve?system=${encodeURIComponent(systemCode)}` },
      { fetchCsrfToken: false },
    );
    return response.data.destination || '';
  } catch (err) {
    const msg = err?.response?.data?.error?.message || err.message;
    throw new Error(`Cannot resolve destination for system "${systemCode}": ${msg}`);
  }
}

async function analyze(body, llmOptions) {
  const log = cds.log('analyzer');
  const parsed = parseEvent(body);
  if (!parsed) throw new Error('Invalid CALM payload: missing startEvent or eventDetailsTable');

  const timing = { start: Date.now() };

  // Resolve SAP destination from system code in CALM event
  const destination = await resolveDestination(parsed.system);
  log.info('Analyzing dump', {
    system: parsed.system,
    destination: destination || '(default)',
    program: parsed.program,
    error: parsed.error,
    model: llmOptions?.model,
  });

  const prompt = buildPrompt(parsed);
  timing.promptBuilt = Date.now();

  const analysis = await callLlmHub(prompt, llmOptions, destination);
  timing.llmDone = Date.now();

  const result = {
    status: 'analyzed',
    system: parsed.system,
    program: parsed.program,
    error: parsed.error,
    exception: parsed.exception,
    user: parsed.user,
    rootCause: analysis.rootCause || '',
    codeSection: analysis.codeSection || '',
    severity: analysis.severity || 'unknown',
    recommendations: analysis.recommendations || [],
    errorMessage: '',
  };

  log.info('Analysis complete', {
    program: parsed.program,
    severity: result.severity,
    timing: {
      promptMs: timing.promptBuilt - timing.start,
      llmMs: timing.llmDone - timing.promptBuilt,
      totalMs: Date.now() - timing.start,
    },
  });

  return result;
}

module.exports = { parseEvent, buildPrompt, callLlmHub, extractJson, analyze };
