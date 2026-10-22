import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The approuter's compression middleware skips only responses marked
// Cache-Control: no-transform. A compressed SSE stream is buffered, so chat
// deltas, step status and dialogue events would not reach the browser live.
test.each([
  'srv/openai-handler.ts',
  'srv/anthropic-handler.ts',
  'srv/lib/dialogue-events-handler.ts',
])('%s marks its event stream no-transform', (file) => {
  const source = readFileSync(join(__dirname, '../..', file), 'utf8');
  expect(source).toMatch(/text\/event-stream/);
  const cacheControl = [
    ...source.matchAll(/['"]Cache-Control['"],?\s*:?\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  expect(cacheControl.length).toBeGreaterThan(0);
  for (const value of cacheControl) expect(value).toContain('no-transform');
});
