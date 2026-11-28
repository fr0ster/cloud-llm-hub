import {
  EMBEDDING_CONTEXT_EXCEEDED,
  InMemoryRag,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultPipeline,
  type PipelineDeps,
} from '@mcp-abap-adt/llm-agent-libs';
import cds from '@sap/cds';
import {
  pipelineFailureLogger,
  withPipelineStep,
} from '../../srv/lib/pipeline-failure-logging';
import { testAccess } from './helpers/test-rag-access';
import { fakePipelineLlm } from './helpers/usage-pipeline';

const caller = {
  userId: 'alice',
  sessionId: 'pipeline-failure',
  isAdmin: false,
};
const privateMessage = 'Private backend error text';

async function runPipeline(
  historyRag: InMemoryRag,
  ragStores?: PipelineDeps['ragStores'],
) {
  const mainLlm = fakePipelineLlm(() => {
    throw new Error('Unexpected model call');
  });
  const pipeline = new DefaultPipeline();
  pipeline.initialize({
    mainLlm,
    mcpClients: [],
    ragAccess: testAccess([caller]),
    historyRag,
    ragStores,
    agentConfig: { classificationEnabled: false },
  });
  const yielded = jest.fn();
  const result = await withPipelineStep('worker-step', () =>
    pipeline.execute(
      'Read the history',
      [],
      {
        caller,
        sessionId: caller.sessionId,
        sessionLogger: pipelineFailureLogger('test-trace'),
      },
      yielded,
    ),
  );
  return { result, yielded };
}

describe('pipeline stage failure logging', () => {
  const log = cds.log('smart-pipeline');

  afterEach(() => jest.restoreAllMocks());

  it.each([
    { code: 'QUERY_ERROR', status: 503, source: 'result' },
    { code: 'QUERY_ERROR', status: 503, source: 'exception' },
    { code: 'QUERY_ERROR', status: 503, source: 'wrapped exception' },
    { code: EMBEDDING_CONTEXT_EXCEEDED, status: 413, source: 'result' },
    { code: EMBEDDING_CONTEXT_EXCEEDED, status: 413, source: 'exception' },
  ])('logs $code from a RAG $source', async ({ code, status, source }) => {
    const logged = jest.spyOn(log, 'error').mockImplementation(() => {});
    const error = Object.assign(new RagError(privateMessage, code), {
      stepId: 'history-step',
      status,
    });
    const historyRag = new InMemoryRag();
    const query = jest
      .spyOn(historyRag, 'query')
      .mockImplementation(async () => {
        if (source === 'exception') throw error;
        if (source === 'wrapped exception')
          throw new Error('History query failed', { cause: error });
        return { ok: false, error };
      });
    const { result, yielded } = await runPipeline(historyRag);

    expect(query).toHaveBeenCalledTimes(1);
    if (source === 'exception' && code === EMBEDDING_CONTEXT_EXCEEDED) {
      expect(yielded).toHaveBeenCalledTimes(1);
      expect(yielded).toHaveBeenCalledWith({ ok: false, error });
    } else {
      expect(yielded).not.toHaveBeenCalled();
    }
    if (source === 'result') expect(result.error).toBe(error);
    expect(logged.mock.calls).toEqual([
      [
        'stage_error_rag-history',
        { traceId: 'test-trace', code, status, stepId: 'history-step' },
      ],
    ]);
  });

  it('keeps failures from parallel RAG stages separate', async () => {
    const logged = jest.spyOn(log, 'error').mockImplementation(() => {});
    const historyRag = new InMemoryRag();
    const documentsRag = new InMemoryRag();
    const historyFailure = {
      code: 'QUERY_ERROR',
      status: 503,
      stepId: 'history-step',
    };
    const documentsFailure = {
      code: EMBEDDING_CONTEXT_EXCEEDED,
      status: 413,
      stepId: 'documents-step',
    };
    jest.spyOn(historyRag, 'query').mockResolvedValue({
      ok: false,
      error: Object.assign(
        new RagError(privateMessage, historyFailure.code),
        historyFailure,
      ),
    });
    jest.spyOn(documentsRag, 'query').mockResolvedValue({
      ok: false,
      error: Object.assign(
        new RagError(privateMessage, documentsFailure.code),
        documentsFailure,
      ),
    });

    const { yielded } = await runPipeline(historyRag, {
      documents: {
        name: 'documents',
        owner: { scope: 'internal' },
        rag: documentsRag,
      },
    });

    expect(yielded).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith('stage_error_rag-history', {
      traceId: 'test-trace',
      ...historyFailure,
    });
    expect(logged).toHaveBeenCalledWith('stage_error_rag-documents', {
      traceId: 'test-trace',
      ...documentsFailure,
    });
  });

  it('uses structured stage error payload fields', () => {
    const logged = jest.spyOn(log, 'error').mockImplementation(() => {});
    const logger = pipelineFailureLogger('test-trace');
    const request = {
      messages: [
        {
          role: 'assistant',
          content: 'Answer',
          providerOutput: { items: ['opaque'] },
        },
      ],
    };

    expect(logger.logStep('llm_request_iter_2', request)).toBe(false);
    logger.logStep('stage_error_retrieval', {
      ...request,
      code: 'QUERY_ERROR',
      status: 503,
      stepId: 'retrieval-step',
      error: privateMessage,
    });

    expect(logged.mock.calls).toEqual([
      [
        'stage_error_retrieval',
        {
          traceId: 'test-trace',
          code: 'QUERY_ERROR',
          status: 503,
          stepId: 'retrieval-step',
        },
      ],
    ]);
  });
});
