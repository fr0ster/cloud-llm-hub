import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
import { exportRecords } from '@mcp-abap-adt/llm-usage';
import { type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { requireAdminRole } from './lib/require-admin-role';
import { exportHubCsv } from './lib/usage/csv';
import { usageRuntime } from './lib/usage/runtime';

const timestamp = z
  .string()
  .regex(/^\d+$/, 'Expected epoch milliseconds')
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const querySchema = z
  .object({
    from: timestamp,
    to: timestamp,
    kinds: z
      .string()
      .regex(
        /^(?:llm\.call|embedding\.call|tool\.call|task|x\.[A-Za-z0-9_.-]+)(?:,(?:llm\.call|embedding\.call|tool\.call|task|x\.[A-Za-z0-9_.-]+))*$/,
      )
      .transform((value: string): string[] => value.split(','))
      .optional(),
    sessionId: z.string().min(1).max(1024).optional(),
    format: z.enum(['jsonl', 'csv']).default('jsonl'),
  })
  .strict()
  .refine(
    (value: { from: number; to: number }): boolean => value.from < value.to,
    { message: 'from must be less than to' },
  );

export function createUsageRouter(): Router {
  const router = Router();
  router.use(requireAdminRole);
  router.all(['/records', '/status'], (req: Request, res: Response): void => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ message: 'Method Not Allowed' });
      return;
    }
    if (req.path.replace(/\/$/, '') === '/status') handleUsageStatus(req, res);
    else void handleUsageRecords(req, res);
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

// The reader owns selection and deduplication. Export one row at a time so the
// library exporter's own deduplication set stays bounded.
async function* jsonl(
  records: AsyncIterable<UsageRecord>,
): AsyncIterable<string> {
  for await (const record of records) {
    async function* row(): AsyncIterable<UsageRecord> {
      yield record;
    }
    yield* exportRecords(row(), 'jsonl');
  }
}

export async function handleUsageRecords(
  req: Request,
  res: Response,
): Promise<void> {
  const runtime = usageRuntime();
  if (!runtime) {
    res.status(404).json({ message: 'Usage recording is off' });
    return;
  }
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      message: parsed.error.issues
        .map((issue: z.core.$ZodIssue): string => issue.message)
        .join('; '),
    });
    return;
  }
  const { format, ...query } = parsed.data;
  res.type(format === 'csv' ? 'text/csv' : 'application/x-ndjson');
  let disconnected = res.destroyed;
  let wake: (() => void) | undefined;
  let reader: AsyncIterator<UsageRecord, void> | undefined;
  let iterator: AsyncIterator<string, void> | undefined;
  const close = (): void => {
    disconnected = true;
    wake?.();
  };
  res.on('close', close);
  try {
    if (disconnected) return;
    const records = runtime.reader().read(query);
    reader = records[Symbol.asyncIterator]();
    const source: AsyncIterable<UsageRecord> = {
      [Symbol.asyncIterator]: (): AsyncIterator<UsageRecord, void> => {
        if (!reader) throw new Error('Missing usage reader');
        return reader;
      },
    };
    const output = format === 'csv' ? exportHubCsv(source) : jsonl(source);
    iterator = output[Symbol.asyncIterator]();
    while (!disconnected) {
      let cancelRead: () => void = (): void => {};
      const closed = new Promise<null>(
        (resolve: (value: null) => void): void => {
          cancelRead = (): void => resolve(null);
          res.once('close', cancelRead);
        },
      );
      let result: IteratorResult<string, void> | null;
      try {
        // race observes a late rejection even if disconnect wins this read.
        result = await Promise.race([iterator.next(), closed]);
      } finally {
        res.removeListener('close', cancelRead);
      }
      if (!result || result.done || disconnected) break;
      const chunk = result.value;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve: () => void): void => {
          wake = resolve;
          res.once('drain', resolve);
          if (disconnected) resolve();
        });
        if (wake) res.removeListener('drain', wake);
        wake = undefined;
      }
      if (disconnected) break;
    }
    if (!disconnected) res.end();
  } catch {
    if (!disconnected) {
      if (!res.headersSent)
        res.status(500).json({ message: 'Usage export failed' });
      else res.destroy();
    }
  } finally {
    res.removeListener('close', close);
    if (wake) res.removeListener('drain', wake);
    // A generator's return can queue behind a pending next; close the reader
    // directly as well, and never hold the HTTP handler on either cleanup.
    void reader?.return?.().catch((): void => {});
    void iterator?.return?.().catch((): void => {});
  }
}
