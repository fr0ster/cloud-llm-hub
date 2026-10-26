import { type Request, type Response, Router } from 'express';
import { logger } from './lib/logger';
import { requireAdminRole } from './lib/require-admin-role';
import { usageRuntime } from './lib/usage/runtime';

export function createUsageRouter(): Router {
  const router = Router();
  router.use(requireAdminRole);
  router.all('/sqlite', (req: Request, res: Response): void => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ message: 'Method Not Allowed' });
      return;
    }
    void handleSqliteDownload(req, res);
  });
  router.all('/status', (req: Request, res: Response): void => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ message: 'Method Not Allowed' });
      return;
    }
    handleUsageStatus(req, res);
  });
  router.use((_req: Request, res: Response): void => {
    res.status(404).json({ message: 'Not Found' });
  });
  return router;
}

export async function handleSqliteDownload(
  _req: Request,
  res: Response,
): Promise<void> {
  const runtime = usageRuntime();
  if (!runtime?.sqliteSnapshot) {
    res.status(404).json({
      message: runtime
        ? 'SQLite usage sink is not active'
        : 'Usage recording is off',
    });
    return;
  }
  const started = Date.now();
  let size = 0;
  let disconnected = res.destroyed;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let waiter: (() => void) | undefined;
  const cancel = (): void => {
    disconnected = true;
    void reader?.cancel().catch((): void => {});
    waiter?.();
  };
  const drain = (): void => {
    waiter?.();
  };
  res.on('close', cancel);
  res.on('error', cancel);
  res.on('drain', drain);
  try {
    const stream = await runtime.sqliteSnapshot();
    reader = stream.getReader();
    if (disconnected) return;
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const instance = (process.env.CF_INSTANCE_INDEX ?? 'local').replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    );
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="usage-${instance}-${timestamp}.sqlite"`,
    );
    res.setHeader('Cache-Control', 'no-store');
    while (!disconnected) {
      const chunk = await reader.read();
      if (disconnected || chunk.done) break;
      size += chunk.value.byteLength;
      if (!res.write(chunk.value)) {
        await new Promise<void>((resolve: () => void): void => {
          waiter = resolve;
          if (disconnected) resolve();
        });
        waiter = undefined;
      }
    }
    if (!disconnected) res.end();
  } catch {
    if (!disconnected) {
      if (res.headersSent) res.destroy();
      else {
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
        res.status(500).json({ message: 'SQLite usage snapshot failed' });
      }
    }
  } finally {
    await reader?.cancel().catch((): void => {});
    reader?.releaseLock();
    res.off('close', cancel);
    res.off('error', cancel);
    res.off('drain', drain);
    logger.info('Usage SQLite download', {
      size,
      durationMs: Date.now() - started,
    });
  }
}

export function handleUsageStatus(_req: Request, res: Response): void {
  const runtime = usageRuntime();
  if (!runtime) {
    res.status(404).json({ message: 'Usage recording is off' });
    return;
  }
  res.json(runtime.status());
}
