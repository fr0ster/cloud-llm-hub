import type { RequestHandler } from 'express';

let ready = false;

export function isRagMigrationReady(): boolean {
  return ready;
}

/** Only startup marks the migration complete, after every provider succeeds. */
export function setRagMigrationReady(value: boolean): void {
  ready = value;
}

/** Installed before all routes; only this data-free vendor asset may pass. */
export function ragReadinessGuard(isReady: () => boolean): RequestHandler {
  return (req, res, next) => {
    if (isReady()) {
      next();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(req.path).toLowerCase();
    } catch {
      path = '';
    }
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      path === '/chat/webapp/vendor/jszip.min.js'
    ) {
      next();
      return;
    }
    res.status(503).json({ error: { message: 'RAG migration not ready yet' } });
  };
}
