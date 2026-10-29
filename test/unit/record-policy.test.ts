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
  expect(recordAttributes({ internal: 'private' })).toEqual({ enabled: true });
  expect(recordAttributes({ enabled: true })).toEqual({ enabled: true });
  expect(recordAttributes({ enabled: false })).toEqual({ enabled: false });
});
