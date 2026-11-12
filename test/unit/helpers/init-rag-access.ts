import {
  createHubRagAccess,
  initHubRagAccess,
} from '../../../srv/lib/rag-access';
import { setRagMigrationReady } from '../../../srv/lib/rag-readiness';

beforeAll(() => {
  if (expect.getState().testPath?.endsWith('rag-access.test.ts')) return;
  initHubRagAccess(createHubRagAccess(null, 'in-memory'));
  // Unit harnesses bypass server startup; complete its in-memory migration.
  setRagMigrationReady(true);
});
