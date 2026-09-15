import type { Response } from 'express';
import { detachedSink } from '../../srv/lib/detached-sink';

function fakeRes(opts: { throwOnWrite?: boolean } = {}) {
  const out: string[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      out.push(`head ${status}`);
      res.headersSent = true;
    },
    setHeader(n: string, v: string) {
      out.push(`header ${n}=${v}`);
    },
    write(c: string) {
      if (opts.throwOnWrite) throw new Error('EPIPE');
      out.push(c);
    },
    end(c?: string) {
      if (c) out.push(c);
      out.push('end');
      res.writableEnded = true;
    },
    status(s: number) {
      out.push(`status ${s}`);
      return res;
    },
    json(b: unknown) {
      out.push(JSON.stringify(b));
      res.writableEnded = true;
    },
  };
  return { res: res as unknown as Response, out };
}

describe('the detached sink', () => {
  it('passes writes through while attached', () => {
    const { res, out } = fakeRes();
    const sink = detachedSink(res);
    sink.writeHead(200, {});
    sink.write('a');
    sink.end('b');
    expect(out).toEqual(['head 200', 'a', 'b', 'end']);
  });

  it('drops every chunk and closing envelope once detached, and none throws', () => {
    const { res, out } = fakeRes();
    const sink = detachedSink(res);
    sink.write('before');
    sink.detach();
    expect(() => {
      sink.write('chunk');
      sink.end('[DONE]');
      sink.json(500, { error: 'late' });
    }).not.toThrow();
    expect(out).toEqual(['before']);
    expect(sink.detached).toBe(true);
  });

  it('detaches itself when the socket is already dead, rather than raising into the pipeline', () => {
    const { res } = fakeRes({ throwOnWrite: true });
    const sink = detachedSink(res);
    expect(() => sink.write('x')).not.toThrow();
    expect(sink.detached).toBe(true);
  });

  it('writes nothing after the response has ended', () => {
    const { res, out } = fakeRes();
    const sink = detachedSink(res);
    sink.end();
    sink.write('late');
    expect(out).toEqual(['end']);
  });
});
