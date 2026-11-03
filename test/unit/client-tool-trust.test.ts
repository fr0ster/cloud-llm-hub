import { toModelToolMessages } from '@mcp-abap-adt/llm-agent';
import {
  clientToolTrust,
  registerClientTools,
  runWithClientTools,
} from '../../srv/lib/client-tool-trust';
import { parseTrustDefaults } from '../../srv/lib/trust';
import { TrustResolver } from '../../srv/lib/trust-resolver';

const resolver = new TrustResolver(
  undefined,
  undefined,
  parseTrustDefaults(undefined),
);
const trust = clientToolTrust(resolver);

test('replayed client results receive tags while stored history stays raw', () => {
  runWithClientTools(() => {
    registerClientTools([{ name: 'read_file' }]);
    const history = [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: 'call1',
            type: 'function' as const,
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      { role: 'tool' as const, content: 'file content', tool_call_id: 'call1' },
    ];
    expect(toModelToolMessages(history, trust)[1].content).toBe(
      '[source: client:read_file; trust 4.4]\nfile content',
    );
    expect(history[1].content).toBe('file content');
    expect(trust('unknown')).toBeUndefined();
    expect(
      clientToolTrust(resolver.forProfile({ trust: { client: 4.1 } }))(
        'read_file',
      ),
    ).toEqual({ source: 'client:read_file', trust: 4.1 });
  });
  expect(trust('read_file')).toBeUndefined();
});

test('client ownership is isolated across concurrent requests', async () => {
  await Promise.all(
    ['read_file', 'search'].map((name) =>
      runWithClientTools(async () => {
        registerClientTools([{ name }]);
        await Promise.resolve();
        expect(trust(name)).toEqual({ source: `client:${name}`, trust: 4.4 });
        expect(
          trust(name === 'search' ? 'read_file' : 'search'),
        ).toBeUndefined();
      }),
    ),
  );
});
