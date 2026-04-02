/**
 * CALM Dump Analyzer — lightweight proxy service.
 *
 * Receives SAP Cloud ALM event JSON, analyzes ABAP dumps via cloud-llm-hub,
 * returns structured diagnosis.
 */

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const CLOUD_LLM_HUB_URL = process.env.CLOUD_LLM_HUB_URL;
const CLOUD_LLM_HUB_TOKEN = process.env.CLOUD_LLM_HUB_TOKEN || '';
const SAP_DESTINATION = process.env.SAP_DESTINATION || '';
const PORT = process.env.PORT || 8080;

if (!CLOUD_LLM_HUB_URL) {
  console.error('CLOUD_LLM_HUB_URL is required');
  process.exit(1);
}

/**
 * Extract key fields from CALM event payload.
 */
function parseEvent(body) {
  const event = body?.startEvent;
  if (!event) return null;

  const table = event.eventDetailsTable;
  const cols = table?.columns || [];
  const row = table?.rows?.[0] || [];

  const colIndex = (name) => cols.indexOf(name);

  return {
    system: event.serviceName || '',
    program: row[colIndex('Program')] || '',
    error: (row[colIndex('Runtime Error~Exception')] || '').split('~')[0],
    exception: (row[colIndex('Runtime Error~Exception')] || '').split('~')[1] || '',
    message: row[colIndex('Message')] || '',
    user: row[colIndex('User')] || '',
    timestamp: row[colIndex('Timestamp')] || event.timestamp || '',
    subject: event.subject || '',
    rating: event.rating || '',
  };
}

/**
 * Build analysis prompt from parsed event.
 */
function buildPrompt(parsed) {
  return `Analyze ABAP dump in system ${parsed.system}:
- Program: ${parsed.program}
- Runtime Error: ${parsed.error}
- Exception: ${parsed.exception}
- Message: ${parsed.message}
- User: ${parsed.user}
- Timestamp: ${parsed.timestamp}

Use MCP tools to read the dump details and source code if available.

Return your analysis as a JSON object (no markdown, raw JSON only) with this structure:
{
  "rootCause": "explanation of why this error happened",
  "codeSection": "description of the relevant code area",
  "severity": "low|medium|high|critical",
  "recommendations": [
    { "type": "fix|investigate|oss_note", "description": "what to do" }
  ]
}`;
}

/**
 * Call cloud-llm-hub and extract JSON from response.
 */
async function callLlmHub(prompt) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (CLOUD_LLM_HUB_TOKEN) {
    headers['Authorization'] = `Bearer ${CLOUD_LLM_HUB_TOKEN}`;
  }
  if (SAP_DESTINATION) {
    headers['x-sap-destination'] = SAP_DESTINATION;
  }

  const response = await fetch(`${CLOUD_LLM_HUB_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`cloud-llm-hub returned ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Extract JSON from response (may be wrapped in markdown code block)
  const jsonMatch = content.match(/```json?\s*([\s\S]*?)```/) || [null, content];
  try {
    return JSON.parse(jsonMatch[1].trim());
  } catch {
    // If LLM returned plain text, wrap it
    return {
      rootCause: content,
      codeSection: '',
      severity: 'unknown',
      recommendations: [],
    };
  }
}

/**
 * POST /analyze — main endpoint.
 */
app.post('/analyze', async (req, res) => {
  try {
    const parsed = parseEvent(req.body);
    if (!parsed) {
      return res.status(400).json({
        status: 'error',
        error: 'Invalid payload: missing startEvent',
      });
    }

    console.log(`Analyzing dump: ${parsed.error} in ${parsed.program} (${parsed.system})`);

    const prompt = buildPrompt(parsed);
    const analysis = await callLlmHub(prompt);

    res.json({
      status: 'analyzed',
      event: parsed,
      analysis: {
        rootCause: analysis.rootCause || '',
        codeSection: analysis.codeSection || '',
        severity: analysis.severity || 'unknown',
      },
      recommendations: analysis.recommendations || [],
    });
  } catch (err) {
    console.error('Analysis failed:', err.message);
    res.status(500).json({
      status: 'error',
      error: err.message,
    });
  }
});

/**
 * GET /health
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', llmHub: CLOUD_LLM_HUB_URL });
});

app.listen(PORT, () => {
  console.log(`CALM Dump Analyzer listening on port ${PORT}`);
  console.log(`  cloud-llm-hub: ${CLOUD_LLM_HUB_URL}`);
  console.log(`  destination: ${SAP_DESTINATION || '(from event)'}`);
});
