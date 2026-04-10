/**
 * CALM Dump Analyzer — CAP OData Service.
 *
 * OData action AnalyzeDump accepts event as LargeString (escaped JSON).
 * For raw CALM JSON, use POST /analyze instead (see server.js).
 */

const cds = require('@sap/cds');
const { analyze } = require('./analyze');

module.exports = class AnalyzerService extends cds.ApplicationService {
  init() {
    this.on('AnalyzeDump', async (req) => {
      const log = cds.log('analyzer');
      log.info('OData AnalyzeDump received', {
        dataKeys: Object.keys(req.data || {}),
        eventType: typeof req.data?.event,
        eventPreview: typeof req.data?.event === 'string' ? req.data.event.slice(0, 200) : String(req.data?.event),
        model: req.data?.model,
      });
      const rawEvent = req.data.event;
      if (!rawEvent) {
        return { status: 'error', errorMessage: 'Missing event payload' };
      }

      let body;
      try {
        body = JSON.parse(rawEvent);
      } catch {
        return { status: 'error', errorMessage: 'Invalid JSON in event payload' };
      }

      try {
        const llmOptions = { model: req.data.model, temperature: req.data.temperature };
        const result = await analyze(body, llmOptions);
        // OData needs recommendations as string
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
