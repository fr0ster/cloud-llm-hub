/**
 * cloud-llm-hub API client.
 * Sends prompts and receives structured responses for test operations.
 */

const LLM_HUB_DESTINATION = 'CLOUD_LLM_HUB';
const SAP_DESTINATION = process.env.SAP_DESTINATION || '';

/**
 * Call cloud-llm-hub with a prompt. Returns LLM response content.
 */
async function callLlmHub(prompt, systemMessage) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

  const headers = { 'Content-Type': 'application/json' };
  if (SAP_DESTINATION) headers['x-sap-destination'] = SAP_DESTINATION;

  const messages = [];
  if (systemMessage) messages.push({ role: 'system', content: systemMessage });
  messages.push({ role: 'user', content: prompt });

  const response = await executeHttpRequest(
    { destinationName: LLM_HUB_DESTINATION },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      data: JSON.stringify({ messages }),
    },
    { fetchCsrfToken: false },
  );

  return response.data.choices?.[0]?.message?.content || '';
}

/**
 * Extract JSON from LLM response (handles markdown blocks, mixed text).
 */
function extractJson(content) {
  if (!content) return null;

  // Try markdown code block
  const mdMatch = content.match(/```json?\s*([\s\S]*?)```/);
  if (mdMatch) {
    try { return JSON.parse(mdMatch[1].trim()); } catch { /* fall through */ }
  }

  // Try first { ... } with matching braces
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

  // Try raw
  try { return JSON.parse(content.trim()); } catch { /* fall through */ }

  return null;
}

/**
 * Check if unit test exists for an ABAP object.
 */
async function checkTest(objectName, destination) {
  const oldDest = SAP_DESTINATION;
  process.env.SAP_DESTINATION_OVERRIDE = destination;

  const prompt = `Check if ABAP object "${objectName}" has unit tests. Use GetUnitTest or search for local test classes.

Return ONLY a JSON object:
{"exists": true/false, "testClasses": ["LTCL_..."], "objectType": "CLAS/PROG/FUGR"}`;

  const content = await callLlmHub(prompt,
    'You are an ABAP test inspector. Respond with ONLY raw JSON. No markdown, no explanations.');

  const result = extractJson(content);
  return result || { exists: false, testClasses: [], objectType: 'CLAS' };
}

/**
 * AI-generate a unit test for an ABAP object.
 */
async function generateTest(objectName, destination, requirements) {
  const prompt = `Generate ABAP unit test for object "${objectName}" in system.
${requirements ? `Requirements: ${requirements}` : ''}

Steps:
1. Read the source code of "${objectName}" using MCP tools
2. Analyze the public interface (methods, parameters, exceptions)
3. Generate a local test class (LTCL_...) with test methods for each public method
4. Follow SAP unit test best practices: GIVEN-WHEN-THEN, use cl_abap_unit_assert

Return ONLY a JSON object:
{"testClassName": "LTCL_...", "source": "CLASS ltcl_... DEFINITION FOR TESTING...", "objectType": "CLAS/PROG", "testMethods": ["test_method1", "test_method2"]}`;

  const content = await callLlmHub(prompt,
    'You are an ABAP unit test generator. Use MCP tools to read the object source. Respond with ONLY raw JSON containing the generated test class source.');

  return extractJson(content);
}

/**
 * Deploy a test to SAP system (create or update).
 */
async function deployTest(objectName, source, destination) {
  const prompt = `Deploy unit test for "${objectName}".
The test source is:
${source}

Steps:
1. Check if the test already exists (GetUnitTest)
2. If exists — update it (UpdateUnitTest)
3. If not — create it (CreateUnitTest)
4. Activate the object

Return ONLY a JSON object:
{"status": "deployed/failed", "testClassName": "LTCL_...", "message": "..."}`;

  const content = await callLlmHub(prompt,
    'You are an ABAP deployment service. Use MCP tools to create/update the test. Respond with ONLY raw JSON.');

  return extractJson(content) || { status: 'failed', message: content };
}

/**
 * Run unit test for an ABAP object.
 */
async function runTest(objectName, destination) {
  const prompt = `Run unit tests for ABAP object "${objectName}".

Steps:
1. Use RunUnitTest to execute the tests
2. Wait for completion (GetUnitTestStatus)
3. Get results (GetUnitTestResult)

Return ONLY a JSON object:
{"status": "passed/failed/error", "passed": N, "failed": N, "skipped": N, "duration": milliseconds, "failures": [{"testClass": "...", "method": "...", "message": "...", "line": N}]}`;

  const content = await callLlmHub(prompt,
    'You are an ABAP test runner. Use MCP tools to run and collect results. Respond with ONLY raw JSON.');

  return extractJson(content) || { status: 'error', message: content };
}

/**
 * AI-analyze a test failure.
 */
async function analyzeFailure(objectName, failures, destination) {
  const prompt = `Analyze unit test failures for "${objectName}":
${JSON.stringify(failures, null, 2)}

Steps:
1. Read the test source and production code using MCP tools
2. Determine root cause for each failure
3. Suggest fixes

Return ONLY a JSON object:
{"analysis": [{"method": "...", "rootCause": "...", "suggestedFix": "..."}]}`;

  const content = await callLlmHub(prompt,
    'You are an ABAP test failure analyst. Use MCP tools to read code. Respond with ONLY raw JSON.');

  return extractJson(content) || { analysis: [] };
}

module.exports = { checkTest, generateTest, deployTest, runTest, analyzeFailure, callLlmHub, extractJson };
