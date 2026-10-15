import { bearerToken } from '../../srv/lib/principal';

test.each([
  ['Bearer x', 'x'],
  ['bearer x', 'x'],
  ['BEARER  x', 'x'],
  ['Bearer\tx', 'x'],
  ['Basic x', undefined],
  [undefined, undefined],
  ['Bearer ', undefined],
])('bearerToken(%s) returns %s', (header, expected) => {
  expect(bearerToken(header)).toBe(expected);
});
