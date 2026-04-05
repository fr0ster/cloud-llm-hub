/**
 * cloud-llm-hub API client.
 * Uses external tools pattern — LLM calls return_result tool with structured JSON
 * instead of returning text that needs parsing.
 */

const LLM_HUB_DESTINATION = 'CLOUD_LLM_HUB';

/**
 * Call cloud-llm-hub with prompt + external tool for structured response.
 * LLM uses MCP tools internally, then calls our external tool with the result.
 */
async function callWithTool(prompt, systemMessage, resultTool, destination) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

  const headers = { 'Content-Type': 'application/json' };
  if (destination) headers['x-sap-destination'] = destination;

  const messages = [];
  if (systemMessage) messages.push({ role: 'system', content: systemMessage });
  messages.push({ role: 'user', content: prompt });

  const response = await executeHttpRequest(
    { destinationName: LLM_HUB_DESTINATION },
    {
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      data: JSON.stringify({
        messages,
        tools: [resultTool],
      }),
    },
    { fetchCsrfToken: false },
  );

  const choice = response.data.choices?.[0];

  // Check for tool call (structured result)
  const toolCall = choice?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      return JSON.parse(toolCall.function.arguments);
    } catch { /* fall through to text parsing */ }
  }

  // Fallback: parse from text content
  const content = choice?.message?.content || '';
  return extractJson(content);
}

/**
 * Fallback JSON extraction from text.
 */
function extractJson(content) {
  if (!content) return null;
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
  return null;
}

// --- Tool definitions per operation ---

const TOOL_CHECK = {
  type: 'function',
  function: {
    name: 'return_check_result',
    description: 'Return the result of checking whether unit tests exist for the given ABAP object.',
    parameters: {
      type: 'object',
      required: ['exists', 'objectType'],
      properties: {
        exists: { type: 'boolean', description: 'Whether unit tests exist for this object' },
        objectType: { type: 'string', enum: ['CLAS', 'PROG', 'FUGR'], description: 'Type of the ABAP object' },
        testClasses: { type: 'array', items: { type: 'string' }, description: 'Names of found test classes (LTCL_...)' },
      },
    },
  },
};

const TOOL_GENERATE = {
  type: 'function',
  function: {
    name: 'return_generated_test',
    description: 'Return the generated ABAP unit test source code.',
    parameters: {
      type: 'object',
      required: ['testClassName', 'source', 'testMethods'],
      properties: {
        testClassName: { type: 'string', description: 'Name of the generated test class (LTCL_...)' },
        source: { type: 'string', description: 'Full ABAP source code of the test class' },
        objectType: { type: 'string', enum: ['CLAS', 'PROG', 'FUGR'] },
        testMethods: { type: 'array', items: { type: 'string' }, description: 'List of test method names' },
      },
    },
  },
};

const TOOL_DEPLOY = {
  type: 'function',
  function: {
    name: 'return_deploy_result',
    description: 'Return the result of deploying the unit test to the SAP system.',
    parameters: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['deployed', 'failed'], description: 'Deployment result' },
        testClassName: { type: 'string', description: 'Name of the deployed test class' },
        message: { type: 'string', description: 'Details or error message' },
      },
    },
  },
};

const TOOL_RUN = {
  type: 'function',
  function: {
    name: 'return_test_results',
    description: 'Return the results of running the unit tests.',
    parameters: {
      type: 'object',
      required: ['status', 'passed', 'failed'],
      properties: {
        status: { type: 'string', enum: ['passed', 'failed', 'error'], description: 'Overall result' },
        passed: { type: 'number', description: 'Number of passed tests' },
        failed: { type: 'number', description: 'Number of failed tests' },
        skipped: { type: 'number', description: 'Number of skipped tests' },
        duration: { type: 'number', description: 'Duration in milliseconds' },
        failures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              testClass: { type: 'string' },
              method: { type: 'string' },
              message: { type: 'string' },
              line: { type: 'number' },
            },
          },
          description: 'Details of failed assertions',
        },
      },
    },
  },
};

const TOOL_ANALYZE = {
  type: 'function',
  function: {
    name: 'return_failure_analysis',
    description: 'Return analysis of test failures with root causes and suggested fixes.',
    parameters: {
      type: 'object',
      required: ['analysis'],
      properties: {
        analysis: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', description: 'Test method that failed' },
              rootCause: { type: 'string', description: 'Why the test failed' },
              suggestedFix: { type: 'string', description: 'How to fix it' },
            },
          },
        },
      },
    },
  },
};

// --- Operations ---

const SYSTEM_MSG = 'You are an ABAP unit test service. Use MCP tools to interact with the SAP system. When done, call the return_* tool with your structured result. Do NOT return text — always use the tool.';

async function checkTest(objectName, destination) {
  const prompt = `Check if ABAP object "${objectName}" has unit tests. Use MCP tools (GetUnitTest or SearchObject) to find local test classes (LTCL_...).`;
  return await callWithTool(prompt, SYSTEM_MSG, TOOL_CHECK, destination) || { exists: false, objectType: 'CLAS', testClasses: [] };
}

async function generateTest(objectName, destination, requirements) {
  const prompt = `Generate ABAP unit test for object "${objectName}".
${requirements ? `Requirements: ${requirements}` : ''}

Steps:
1. Read the source code of "${objectName}" using MCP tools
2. Analyze the public interface
3. Generate a local test class (LTCL_...) following SAP best practices (GIVEN-WHEN-THEN, cl_abap_unit_assert)
4. Call return_generated_test with the result`;

  return await callWithTool(prompt, SYSTEM_MSG, TOOL_GENERATE, destination);
}

async function deployTest(objectName, source, destination) {
  const prompt = `Deploy unit test for "${objectName}" to the SAP system.
Test source:
${source}

Steps:
1. Check if the test already exists (GetUnitTest)
2. If exists — update (UpdateUnitTest), if not — create (CreateUnitTest)
3. Activate the object
4. Call return_deploy_result with the result`;

  return await callWithTool(prompt, SYSTEM_MSG, TOOL_DEPLOY, destination);
}

async function runTest(objectName, destination) {
  const prompt = `Run unit tests for ABAP object "${objectName}".

Steps:
1. Run the tests (RunUnitTest)
2. Check status (GetUnitTestStatus) until complete
3. Get results (GetUnitTestResult)
4. Call return_test_results with passed/failed/failures`;

  return await callWithTool(prompt, SYSTEM_MSG, TOOL_RUN, destination);
}

async function analyzeFailure(objectName, failures, destination) {
  const prompt = `Analyze unit test failures for "${objectName}":
${JSON.stringify(failures, null, 2)}

Steps:
1. Read the test source and production code using MCP tools
2. Determine root cause for each failure
3. Suggest fixes
4. Call return_failure_analysis with the analysis`;

  return await callWithTool(prompt, SYSTEM_MSG, TOOL_ANALYZE, destination);
}

module.exports = { checkTest, generateTest, deployTest, runTest, analyzeFailure };
