import { validatedClientTurnId } from '../../srv/lib/dialogue-turn-source';

test.each(['abc-123', 'A'.repeat(64)])('accepts client turn ID %s', (value) => {
  expect(validatedClientTurnId(value)).toBe(value);
});
test.each([
  '',
  'a'.repeat(65),
  'with space',
  'underscore_id',
  ['abc'],
  undefined,
])('rejects malformed client turn ID %p', (value) => {
  expect(validatedClientTurnId(value)).toBeUndefined();
});
