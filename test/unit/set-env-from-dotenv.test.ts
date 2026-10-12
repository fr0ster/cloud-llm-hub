// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseDotenv } = require('../../tools/set-env-from-dotenv.js');

describe('parseDotenv', () => {
  test('reads KEY=VALUE, skips blanks and comments, keeps "=" in values', () => {
    const text = [
      '# AI Core key',
      '',
      'AICORE_AUTH_URL=https://x.example/oauth',
      '  AICORE_CLIENT_SECRET = a=b&c|d^e  ',
      'not a var',
      '=no-key',
    ].join('\r\n');
    expect(parseDotenv(text)).toEqual([
      ['AICORE_AUTH_URL', 'https://x.example/oauth'],
      ['AICORE_CLIENT_SECRET', 'a=b&c|d^e'],
    ]);
  });

  test('empty file → no vars', () => {
    expect(parseDotenv('\n# only a comment\n')).toEqual([]);
  });
});
