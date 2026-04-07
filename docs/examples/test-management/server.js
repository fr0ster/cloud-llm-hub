/**
 * ABAP Unit Test Service
 *
 * REST API for ABAP unit test lifecycle:
 * - check: does test exist?
 * - generate: AI creates test draft
 * - deploy: write test to SAP
 * - run: execute test
 * - status/results: get run results
 *
 * Connects to SAP via cloud-llm-hub (BTP Destination).
 * Stores mappings in SQLite.
 */

const express = require('express');
const db = require('./lib/db');
const sap = require('./lib/sap-client');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8080;

// --- Health ---

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    destination: process.env.SAP_DESTINATION || 'not set',
    timestamp: new Date().toISOString(),
  });
});

// --- Mappings ---

app.get('/mappings', (_req, res) => {
  res.json({ mappings: db.listAll() });
});

// --- Tests API ---

/**
 * POST /tests/check
 * { objectName, destination }
 * → { exists, testClasses, objectType }
 */
app.post('/tests/check', async (req, res) => {
  const { objectName, destination, model, temperature } = req.body;
  if (!objectName || !destination) {
    return res.status(400).json({ error: 'objectName and destination required' });
  }

  try {
    const result = await sap.checkTest(objectName, destination, { model, temperature });

    // Update mapping
    db.upsert({
      objectName,
      objectType: result.objectType || 'CLAS',
      destination,
      status: result.exists ? 'exists' : 'not_found',
    });

    res.json({ objectName, destination, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tests/generate
 * { objectName, destination, requirements?, jiraIssue? }
 * → { status: "draft", testClassName, source, testMethods }
 */
app.post('/tests/generate', async (req, res) => {
  const { objectName, destination, requirements, jiraIssue, model, temperature } = req.body;
  if (!objectName || !destination) {
    return res.status(400).json({ error: 'objectName and destination required' });
  }

  try {
    const result = await sap.generateTest(objectName, destination, requirements, { model, temperature });
    if (!result || !result.source) {
      return res.status(500).json({ error: 'Failed to generate test', details: result });
    }

    // Store draft
    const mapping = db.upsert({
      objectName,
      objectType: result.objectType || 'CLAS',
      destination,
      jiraIssue,
      status: 'draft',
      draftSource: result.source,
    });

    res.json({
      status: 'draft',
      objectName,
      destination,
      testClassName: result.testClassName,
      source: result.source,
      testMethods: result.testMethods || [],
      mappingId: mapping.id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tests/deploy
 * { objectName, destination, source? }
 * → { status: "deployed", testClassName }
 *
 * If source not provided, uses draft from mapping.
 */
app.post('/tests/deploy', async (req, res) => {
  const { objectName, destination, model, temperature } = req.body;
  let { source } = req.body;

  if (!objectName || !destination) {
    return res.status(400).json({ error: 'objectName and destination required' });
  }

  // If no source provided, use stored draft
  if (!source) {
    const mapping = db.findByObject(objectName, destination);
    if (!mapping || !mapping.draft_source) {
      return res.status(400).json({ error: 'No source provided and no draft found' });
    }
    source = mapping.draft_source;
  }

  try {
    const result = await sap.deployTest(objectName, source, destination, { model, temperature });

    db.upsert({
      objectName,
      destination,
      status: result.status === 'deployed' ? 'deployed' : 'deploy_failed',
    });

    res.json({ objectName, destination, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tests/run
 * { objectName, destination }
 * → { status, passed, failed, skipped, duration, failures }
 */
app.post('/tests/run', async (req, res) => {
  const { objectName, destination, model, temperature } = req.body;
  if (!objectName || !destination) {
    return res.status(400).json({ error: 'objectName and destination required' });
  }

  try {
    const result = await sap.runTest(objectName, destination, { model, temperature });

    db.updateStatus(objectName, destination,
      result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'error');

    res.json({ objectName, destination, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tests/analyze
 * { objectName, destination, failures }
 * → { analysis: [{ method, rootCause, suggestedFix }] }
 */
app.post('/tests/analyze', async (req, res) => {
  const { objectName, destination, failures, model, temperature } = req.body;
  if (!objectName || !failures) {
    return res.status(400).json({ error: 'objectName and failures required' });
  }

  try {
    const result = await sap.analyzeFailure(objectName, failures, destination, { model, temperature });
    res.json({ objectName, destination, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Shutdown ---

process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`ABAP Unit Test Service listening on port ${PORT}`);
  console.log(`  SAP destination: ${process.env.SAP_DESTINATION || '(from request)'}`);
});
