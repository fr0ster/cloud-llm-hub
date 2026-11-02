import { recordAttributes, recordPolicy } from '../../srv/lib/record-policy';

test.each([
  [{}, true, { visible: true }],
  [{ enabled: true }, true, { visible: true }],
  [{ enabled: false }, true, { visible: false, reason: 'record-disabled' }],
  [{}, false, { visible: false, reason: 'collection-disabled' }],
  [
    { enabled: false },
    false,
    { visible: false, reason: 'collection-disabled' },
  ],
] as const)(
  'record policy for %j in enabled collection %s',
  (metadata, enabled, expected) => {
    expect(recordPolicy(metadata, enabled)).toEqual(expected);
  },
);

test('safe record attributes normalize enablement and exclude other metadata', () => {
  expect(
    recordAttributes(
      { id: 'r', text: '', createdAt: '', metadata: { internal: 'private' } },
      { trusted: false },
    ),
  ).toEqual({ enabled: true, trusted: false });
  expect(
    recordAttributes(
      { id: 'r', text: '', createdAt: '', metadata: { enabled: true } },
      { trusted: false },
    ),
  ).toEqual({ enabled: true, trusted: false });
  expect(
    recordAttributes(
      { id: 'r', text: '', createdAt: '', metadata: { enabled: false } },
      { trusted: false },
    ),
  ).toEqual({ enabled: false, trusted: false });
});
