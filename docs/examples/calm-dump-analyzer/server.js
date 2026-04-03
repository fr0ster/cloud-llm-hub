/**
 * Custom CAP server — Basic→Bearer middleware + REST /analyze endpoint.
 *
 * POST /analyze accepts raw CALM JSON payload directly.
 * No wrapping needed — CALM, Integration Suite, any M2M client POSTs as-is.
 */

const cds = require('@sap/cds');
const express = require('express');
const { createBasicToBearerMiddleware } = require('./srv/basic-to-bearer');
const { analyze } = require('./srv/analyze');

cds.on('bootstrap', (app) => {
  const [context, , auth] = cds.middlewares.before;
  const wrappedAuth = createBasicToBearerMiddleware(auth);
  cds.middlewares.before = [context, wrappedAuth];

  // POST /analyze — raw CALM JSON, no OData wrapping
  app.use('/analyze', context, wrappedAuth, express.json({ limit: '1mb' }));
  app.post('/analyze', async (req, res) => {
    try {
      const result = await analyze(req.body);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('Invalid CALM') ? 400 : 500;
      res.status(status).json({ status: 'error', errorMessage: err.message });
    }
  });
});

module.exports = cds.server;
