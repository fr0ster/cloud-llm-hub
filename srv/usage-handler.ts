import { type Request, type Response, Router } from 'express';
import { requireAdminRole } from './lib/require-admin-role';
import { usageRuntime } from './lib/usage/runtime';

export function createUsageRouter(): Router {
  const router = Router();
  router.use(requireAdminRole);
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

export function handleUsageStatus(_req: Request, res: Response): void {
  const runtime = usageRuntime();
  if (!runtime) {
    res.status(404).json({ message: 'Usage recording is off' });
    return;
  }
  res.json(runtime.status());
}
