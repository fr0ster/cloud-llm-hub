import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { checkHybrid } = require('../../tools/dev-local.js') as any;

it('warns about default-env.json, naming the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devlocal-'));
  expect(checkHybrid(dir)).toBeNull();
  fs.writeFileSync(path.join(dir, 'default-env.json'), '{}');
  expect(checkHybrid(dir)).toMatch(/default-env\.json/);
});
