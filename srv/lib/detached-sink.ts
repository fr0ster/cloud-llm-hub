import type { Response } from 'express';

/**
 * Where a pipeline's output goes, detachable.
 *
 * A client that disconnects ends nothing: SAP is still waiting for the rest of
 * a write chain, and nobody else is. What the pipeline must not do is fail on
 * the dead socket. After `detach`, every write is dropped before the socket;
 * a write that throws detaches the sink instead of raising into the pipeline.
 */
export interface OutputSink {
  readonly detached: boolean;
  detach(): void;
  writeHead(status: number, headers?: Record<string, string>): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  end(chunk?: string): void;
  json(status: number, body: unknown): void;
}

export function detachedSink(res: Response): OutputSink {
  let detached = false;
  const guard = (fn: () => void) => {
    if (detached || res.writableEnded || res.destroyed) return;
    try {
      fn();
    } catch {
      detached = true;
    }
  };
  return {
    get detached() {
      return detached || res.writableEnded || res.destroyed;
    },
    detach() {
      detached = true;
    },
    writeHead: (status, headers) =>
      guard(() => {
        if (!res.headersSent) res.writeHead(status, headers);
      }),
    setHeader: (name, value) =>
      guard(() => {
        if (!res.headersSent) res.setHeader(name, value);
      }),
    write: (chunk) =>
      guard(() => {
        res.write(chunk);
      }),
    end: (chunk) =>
      guard(() => {
        if (chunk === undefined) res.end();
        else res.end(chunk);
      }),
    json: (status, body) =>
      guard(() => {
        res.status(status).json(body);
      }),
  };
}

/** Send stream headers with the first event or heartbeat. */
export function streamWriter(out: OutputSink, headers: Record<string, string>) {
  const streamHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...headers,
  };
  return (chunk: string) => {
    out.writeHead(200, streamHeaders);
    out.write(chunk);
  };
}
