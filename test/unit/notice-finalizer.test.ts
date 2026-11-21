import { NoticeFinalizer } from '../../srv/lib/notice-finalizer';

test.each([false, true])(
  'fixed finalization forwards the original answer once (streamed: %s)',
  async (streamed) => {
    const answer = 'I created and activated class ZTEST.';
    const onPartial = jest.fn();
    const result = await new NoticeFinalizer().finalize({
      prompt: 'Create class ZTEST',
      objective: 'Create class ZTEST',
      executionTrace: [],
      interpreterOutput: answer,
      interpreterContentStreamed: streamed,
      onPartial,
    });
    expect(result).toEqual({ output: answer });
    if (streamed) expect(onPartial).not.toHaveBeenCalled();
    else
      expect(onPartial.mock.calls).toEqual([
        [{ kind: 'content', delta: answer }],
      ]);
  },
);
