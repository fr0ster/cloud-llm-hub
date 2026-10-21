import type { RunRecord } from '@mcp-abap-adt/llm-agent';
import type { DeletableRunRecordStore } from '../../../srv/lib/run-record-store';
import { runWithSessionId } from '../../../srv/request-session';
export function scopedStore<T extends DeletableRunRecordStore>(store: T) {
  return {
    load: (session: string) =>
      runWithSessionId(session, () => store.load(session), [], 'alice'),
    save: (session: string, record: RunRecord) =>
      runWithSessionId(session, () => store.save(session, record), [], 'alice'),
    delete: (session: string) => store.delete('alice', session),
  };
}
