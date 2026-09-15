import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, '../..', f), 'utf8');

describe('no client of ours names a session', () => {
  // The browser's chat session survives on the cookie alone. A client still
  // inventing an id and sending it would now be sending something nobody reads,
  // and would look to its author as if it mattered.
  for (const file of [
    'app/chat/webapp/index.html',
    'app/chat/webapp/util/StreamClient.js',
    'app/chat/webapp/controller/Chat.controller.js',
  ]) {
    it(`${file} sends no x-session-id`, () => {
      expect(read(file)).not.toMatch(/x-session-id/i);
    });
  }
});
