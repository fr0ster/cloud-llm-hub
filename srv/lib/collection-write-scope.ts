import { collectionWriteError } from './rag-access';

export {
  withCollectionRestScope,
  withCollectionToolScope,
} from './collection-write-context';

export function assertCollectionWrite(
  meta: {
    id?: string;
    collectionKind?: string;
    scope?: string;
    owner?: string;
  },
  operation?: 'create' | 'add',
  recordId?: string,
): void {
  const refusal = collectionWriteError(meta, operation, recordId);
  if (refusal) throw refusal;
}
