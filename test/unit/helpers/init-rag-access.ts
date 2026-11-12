import {
  createHubRagAccess,
  initHubRagAccess,
} from '../../../srv/lib/rag-access';

beforeAll(() => {
  if (expect.getState().testPath?.endsWith('rag-access.test.ts')) return;
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
});
