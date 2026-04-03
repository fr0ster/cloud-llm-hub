/**
 * Custom CAP server — adds Basic→Bearer middleware for M2M auth.
 *
 * Allows external services (CALM, Integration Suite) to authenticate
 * with XSUAA client_id:client_secret via HTTP Basic auth.
 */

const cds = require('@sap/cds');
const { createBasicToBearerMiddleware } = require('./srv/basic-to-bearer');

cds.on('bootstrap', (app) => {
  // Wrap CAP auth middleware with Basic→Bearer exchange
  const [context, , auth] = cds.middlewares.before;
  const wrappedAuth = createBasicToBearerMiddleware(auth);

  // Replace auth middleware for all routes
  cds.middlewares.before = [context, wrappedAuth];
});

module.exports = cds.server;
