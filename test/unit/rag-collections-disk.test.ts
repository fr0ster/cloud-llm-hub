jest.mock(
  '@sap/cds',
  () => ({
    __esModule: true,
    default: { log: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
  }),
  { virtual: true },
);

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CollectionRegistry } from '../../srv/rag-collections';

let dir: string;
let reg: CollectionRegistry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-disk-'));
  reg = new CollectionRegistry({ storagePath: dir });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A collection with one document written, so its directory exists. */
async function withDocument(
  id: string,
  meta: {
    scope: 'session' | 'user';
    owner: string;
    sessionId?: string;
    expiresAt?: number;
  },
): Promise<string> {
  reg.createCollection({
    id,
    logicalId: id.split('__')[0],
    displayName: id,
    description: '',
    ...meta,
  });
  await reg.addDocument(id, { id: 'd1', text: 'hello', metadata: {} });
  const collectionDir = path.join(dir, id);
  // Guard the premise: a test that never wrote a directory proves nothing
  // about removing one.
  expect(fs.existsSync(collectionDir)).toBe(true);
  return collectionDir;
}

describe('every way a collection ends takes its directory with it', () => {
  it('deleteCollection, as it always did', async () => {
    const d = await withDocument('u__u_1', { scope: 'user', owner: 'alice' });
    reg.deleteCollection('u__u_1');
    expect(reg.getCollection('u__u_1')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });

  it('deleteSessionCollections — logout and clear-chat, which leaked', async () => {
    const d = await withDocument('s__s_1', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'x',
      expiresAt: Date.now() + 60_000,
    });
    reg.deleteSessionCollections('alice', 'x');
    expect(reg.getCollection('s__s_1')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });

  it('sweepExpiredSessions — the TTL, which leaked on a timer', async () => {
    const d = await withDocument('s__s_2', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'y',
      expiresAt: Date.now() - 1,
    });
    reg.sweepExpiredSessions();
    expect(reg.getCollection('s__s_2')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });

  it('leaves what did not end on disk', async () => {
    const live = await withDocument('s__s_3', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'z',
      expiresAt: Date.now() + 60_000,
    });
    const user = await withDocument('u__u_2', {
      scope: 'user',
      owner: 'alice',
    });
    reg.sweepExpiredSessions();
    reg.deleteSessionCollections('bob', 'z');
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(user)).toBe(true);
  });

  it('forgets the enabled flag of what it removed', async () => {
    await withDocument('s__s_4', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'w',
      expiresAt: Date.now() + 60_000,
    });
    reg.setEnabled('alice', 's__s_4', true);
    reg.deleteSessionCollections('alice', 'w');
    expect(reg.getEnabled('alice', 's__s_4')).toBeUndefined();
  });
});

describe('hasSessionCollections', () => {
  it('answers per user and session', async () => {
    await withDocument('s__s_5', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'v',
      expiresAt: Date.now() + 60_000,
    });
    expect(reg.hasSessionCollections('alice', 'v')).toBe(true);
    expect(reg.hasSessionCollections('bob', 'v')).toBe(false);
    expect(reg.hasSessionCollections('alice', 'other')).toBe(false);
  });
});

describe('a directory that will not go', () => {
  /** rmSync fails with EACCES for this one path and works for every other. */
  function failRemovalOf(target: string) {
    const real = fs.rmSync;
    return jest.spyOn(fs, 'rmSync').mockImplementation(((
      p: fs.PathLike,
      opts?: fs.RmOptions,
    ) => {
      if (String(p) === target) {
        throw Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        });
      }
      return real(p, opts);
    }) as typeof fs.rmSync);
  }

  afterEach(() => jest.restoreAllMocks());

  it('keeps the collection registered and throws, so a later attempt removes both', async () => {
    const d = await withDocument('s__s_6', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'f',
      expiresAt: Date.now() + 60_000,
    });
    const spy = failRemovalOf(d);
    expect(() => reg.deleteSessionCollections('alice', 'f')).toThrow('EACCES');
    // The session still counts as holding state: nothing let go of it.
    expect(reg.hasSessionCollections('alice', 'f')).toBe(true);
    expect(fs.existsSync(d)).toBe(true);

    spy.mockRestore();
    reg.deleteSessionCollections('alice', 'f');
    expect(reg.hasSessionCollections('alice', 'f')).toBe(false);
    expect(fs.existsSync(d)).toBe(false);
  });

  it('still removes the session’s other collections', async () => {
    const bad = await withDocument('s__s_7', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'g',
      expiresAt: Date.now() + 60_000,
    });
    const good = await withDocument('s__s_8', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'g',
      expiresAt: Date.now() + 60_000,
    });
    failRemovalOf(bad);
    expect(() => reg.deleteSessionCollections('alice', 'g')).toThrow('EACCES');
    expect(reg.getCollection('s__s_8')).toBeNull();
    expect(fs.existsSync(good)).toBe(false);
    expect(reg.getCollection('s__s_7')).not.toBeNull();
    expect(fs.existsSync(bad)).toBe(true);
  });

  it('deleteCollection throws and keeps the collection', async () => {
    const d = await withDocument('u__u_3', { scope: 'user', owner: 'alice' });
    failRemovalOf(d);
    expect(() => reg.deleteCollection('u__u_3')).toThrow('EACCES');
    expect(reg.getCollection('u__u_3')).not.toBeNull();
    expect(fs.existsSync(d)).toBe(true);
  });

  it('the TTL sweep keeps what it could not remove for its next pass', async () => {
    const d = await withDocument('s__s_9', {
      scope: 'session',
      owner: 'alice',
      sessionId: 'h',
      expiresAt: Date.now() - 1,
    });
    const spy = failRemovalOf(d);
    expect(() => reg.sweepExpiredSessions()).not.toThrow();
    expect(reg.getCollection('s__s_9')).not.toBeNull();
    expect(fs.existsSync(d)).toBe(true);

    spy.mockRestore();
    reg.sweepExpiredSessions();
    expect(reg.getCollection('s__s_9')).toBeNull();
    expect(fs.existsSync(d)).toBe(false);
  });
});
