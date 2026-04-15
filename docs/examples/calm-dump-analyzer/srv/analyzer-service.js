/**
 * CALM Dump Analyzer — CAP OData Service.
 *
 * OData action AnalyzeDump accepts event as LargeString (escaped JSON).
 * For raw CALM JSON, use POST /analyze instead (see server.js).
 */

const cds = require('@sap/cds');
const { analyze, analyzeByParams } = require('./analyze');

module.exports = class AnalyzerService extends cds.ApplicationService {
  init() {
    this.on('AnalyzeByParams', async (req) => {
      const log = cds.log('analyzer');
      const { user, system, timestamp, model, temperature } = req.data;
      if (!user || !system || !timestamp) {
        return { status: 'error', errorMessage: 'Missing required parameters: user, system, timestamp' };
      }
      log.info('AnalyzeByParams', { user, system, timestamp, model });
      try {
        const llmOptions = { model, temperature };
        const result = await analyzeByParams({ user, system, timestamp }, llmOptions);
        result.recommendations = JSON.stringify(result.recommendations);
        return result;
      } catch (err) {
        return { status: 'error', errorMessage: err.message };
      }
    });

    this.on('AnalyzeDump', async (req) => {
      const log = cds.log('analyzer');
      const { user, system, timestamp, model, temperature } = req.data;
      if (!user || !system || !timestamp) {
        return { status: 'error', errorMessage: 'Missing required parameters: user, system, timestamp' };
      }
      log.info('AnalyzeDump', { user, system, timestamp, model });
      try {
        const llmOptions = { model, temperature };
        const result = await analyzeByParams({ user, system, timestamp }, llmOptions);
        result.recommendations = JSON.stringify(result.recommendations);
        return result;
      } catch (err) {
        return { status: 'error', errorMessage: err.message };
      }
    });

    this.on('Health', () => ({
      status: 'ok',
      llmHub: `destination:CLOUD_LLM_HUB`,
      timestamp: new Date().toISOString(),
    }));

    return super.init();
  }
};
