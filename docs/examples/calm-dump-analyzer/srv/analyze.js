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

Steps (exactly 2 tool calls, no more):
1. RuntimeListDumps with user="{user}" and from/to ±5 minutes around {timestamp} in YYYYMMDDHHMMSS format. Pick the dump matching error {error}.
2. RuntimeGetDumpById with dump_id from step 1. Do NOT call it again with different parameters.
Then analyze and respond.

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

async function callLlmHub(prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (SAP_DESTINATION) headers['x-sap-destination'] = SAP_DESTINATION;

  const response = await executeHttpRequest(
    { destinationName: LLM_HUB_DESTINATION },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      data: JSON.stringify({
        messages: [
          { role: 'system', content: 'You are an ABAP dump analysis service. You MUST respond with ONLY a raw JSON object. No markdown, no code blocks, no explanations, no text before or after the JSON. Your entire response must be parseable by JSON.parse().' },
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
async function analyze(body) {
  const log = cds.log('analyzer');
  const parsed = parseEvent(body);
  if (!parsed) throw new Error('Invalid CALM payload: missing startEvent or eventDetailsTable');

  const timing = { start: Date.now() };

  log.info('Analyzing dump', { system: parsed.system, program: parsed.program, error: parsed.error });

  const prompt = buildPrompt(parsed);
  timing.promptBuilt = Date.now();

  const analysis = await callLlmHub(prompt);
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
