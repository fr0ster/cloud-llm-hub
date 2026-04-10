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
  // Capture raw body for diagnostics before JSON parsing
  app.use('/analyze', context, wrappedAuth, (req, _res, next) => {
    let rawChunks = [];
    req.on('data', (chunk) => rawChunks.push(chunk));
    req.on('end', () => { req._rawBody = Buffer.concat(rawChunks).toString('utf-8'); });
    next();
  }, express.json({ limit: '1mb' }));
  app.post('/analyze', async (req, res) => {
    const log = cds.log('analyzer');
    log.info('POST /analyze received', {
      contentType: req.headers['content-type'],
      contentLength: req.headers['content-length'],
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : [],
      hasStartEvent: !!req.body?.startEvent,
      rawBodyLength: req._rawBody?.length || 0,
      rawBodyPreview: (req._rawBody || '').slice(0, 500),
      parsedBodyPreview: req.body ? JSON.stringify(req.body).slice(0, 500) : 'null',
    });
    try {
      const llmOptions = { model: req.body.model, temperature: req.body.temperature };
      const result = await analyze(req.body, llmOptions);
      res.json(result);
    } catch (err) {
      const status = err.message.includes('Invalid CALM') ? 400 : 500;
      res.status(status).json({ status: 'error', errorMessage: err.message });
    }
  });
});

module.exports = cds.server;
