import { SettingsService } from '../../srv/settings-service';

describe('SettingsService', () => {
  const fakeDbResponses: Record<
    string,
    { value: string; dataType: string } | undefined
  > = {};
  const fakeRun = jest.fn(async (key: string) => fakeDbResponses[key]);
  let svc: SettingsService;

  beforeEach(() => {
    fakeRun.mockClear();
    for (const k of Object.keys(fakeDbResponses)) delete fakeDbResponses[k];
    svc = new SettingsService({ runOne: fakeRun }, 5000);
  });

  test('get returns string value from DB', async () => {
    fakeDbResponses.POLL_INTERVAL_MS = { value: '60000', dataType: 'int' };
    expect(await svc.get('POLL_INTERVAL_MS')).toBe('60000');
  });

  test('getInt parses int', async () => {
    fakeDbResponses.POLL_INTERVAL_MS = { value: '60000', dataType: 'int' };
    expect(await svc.getInt('POLL_INTERVAL_MS')).toBe(60000);
  });

  test('getBool parses boolean values', async () => {
    fakeDbResponses.FEATURE = { value: 'true', dataType: 'bool' };
    expect(await svc.getBool('FEATURE')).toBe(true);
  });

  test('getCsv splits comma-separated', async () => {
    fakeDbResponses.LABELS = { value: 'a,b,c', dataType: 'csv' };
    expect(await svc.getCsv('LABELS')).toEqual(['a', 'b', 'c']);
  });

  test('caches within TTL', async () => {
    fakeDbResponses.K = { value: 'v', dataType: 'string' };
    await svc.get('K');
    await svc.get('K');
    expect(fakeRun).toHaveBeenCalledTimes(1);
  });

  test('invalidate forces re-read', async () => {
    fakeDbResponses.K = { value: 'v', dataType: 'string' };
    await svc.get('K');
    svc.invalidate('K');
    await svc.get('K');
    expect(fakeRun).toHaveBeenCalledTimes(2);
  });

  test('returns undefined for unknown', async () => {
    expect(await svc.get('NONE')).toBeUndefined();
  });

  test('getInt returns fallback when missing', async () => {
    expect(await svc.getInt('MISSING', 42)).toBe(42);
  });
});
