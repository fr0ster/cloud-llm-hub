import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import type { IUsageRecorder } from '@mcp-abap-adt/llm-agent';
import type { Request, Response } from 'express';
import { type EndReason, type Protocol, requestRecord } from './hub-records';
import { usageRuntime } from './runtime';
import {
  holdSessionDelivery,
  sessionMessageDelivered,
  sessionRequestAdmitted,
} from './session-records';
import type { UsageSession } from './storage-snapshot';

export interface RequestMeasurement {
  readonly traceId: string;
  bind(usage: IUsageRecorder | undefined, session?: UsageSession): void;
  setStream(stream: boolean): void;
  admitted(): void;
  turnEnded(): void;
  messageDelivered(count?: number): void;
  deliverOnResponseEnd(count?: number): void;
  expectMessages(count: number): void;
  end(reason: EndReason): void;
  responseEnded(reason: EndReason): void;
  outputBytes(bytes: number): void;
  finish(): void;
}
const requests = new WeakMap<Request, RequestMeasurement>();
const responses = new WeakMap<Response, RequestMeasurement>();
export const requestMeasurement = (
  req: Request,
): RequestMeasurement | undefined => requests.get(req);
export const responseMeasurement = (
  res: Response,
): RequestMeasurement | undefined => responses.get(res);

/** Installed only when request or session recording needs request counters. Own work includes any returned continuation. */
export function measureRequest(
  req: Request,
  res: Response | undefined,
  session: UsageSession,
  protocol: Protocol,
  stream: boolean,
  tool?: string,
): RequestMeasurement | undefined {
  const runtime = usageRuntime();
  if (!runtime || (!runtime.enabled('request') && !runtime.enabled('session')))
    return undefined;
  const startedAt = Date.now();
  // Establish the pipeline's trace before admission; requestId is derived from it.
  const traceId =
    protocol === 'mcp-agent' ? `agent-step-${randomUUID()}` : randomUUID();
  const requestId = traceId;
  if (!session.sessionId) session = { ...session, sessionId: requestId };
  let usage = runtime
    .forSession(session)
    .with({ requestId, traceId: requestId });
  let admittedAt = startedAt;
  let turnEndAt: number | undefined;
  let responseEndAt: number | undefined;
  let endReason: EndReason = 'done';
  let messagesDelivered = 0;
  let pendingMessages = 0;
  let expectedMessages: number | undefined;
  let finished = false;
  let admitted = false;
  let releaseDelivery: (() => void) | undefined;
  let bytesWritten = 0;
  let complete: (() => void) | undefined;
  // Transport bytes include HTTP framing and any compression. Start only when
  // this response owns the socket, before its queued output is flushed.
  let socket = res?.socket;
  let initialBytes = socket?.bytesWritten ?? 0;
  const assigned = (ownedSocket: Socket): void => {
    socket = ownedSocket;
    initialBytes = ownedSocket.bytesWritten;
  };
  if (!socket) res?.once('socket', assigned);
  const responseEnded = (): void => {
    if (responseEndAt !== undefined) return;
    responseEndAt = Date.now();

    if (res && !res.writableFinished) endReason = 'disconnected';
    if ((!res || res.writableFinished) && pendingMessages > 0) {
      for (let i = 0; i < pendingMessages; i++)
        sessionMessageDelivered(session);
      messagesDelivered += pendingMessages;
      pendingMessages = 0;
    }
    if (socket) bytesWritten = Math.max(0, socket.bytesWritten - initialBytes);
    complete?.();
  };
  // Freeze before Node's finish listener assigns and flushes the next response.
  res?.prependOnceListener('finish', responseEnded);
  res?.once('close', responseEnded);
  const measurement: RequestMeasurement = {
    traceId,
    bind(recorder: IUsageRecorder | undefined, identity?: UsageSession): void {
      if (recorder) usage = recorder;
      if (identity) {
        session = identity;
        if (!recorder)
          usage = runtime
            .forSession(identity)
            .with({ requestId, traceId: requestId });
      }
    },
    setStream(value: boolean): void {
      stream = value;
    },
    admitted(): void {
      if (admitted) return;
      admitted = true;
      releaseDelivery = holdSessionDelivery(session);
      admittedAt = Date.now();
      sessionRequestAdmitted(session, protocol);
    },
    turnEnded(): void {
      turnEndAt = Date.now();
    },
    expectMessages(count: number): void {
      expectedMessages = count;
    },
    deliverOnResponseEnd(
      count: number | undefined = expectedMessages ?? 1,
    ): void {
      if (responseEndAt !== undefined && (!res || res.writableFinished)) {
        measurement.messageDelivered(count);
      } else pendingMessages += count;
    },
    messageDelivered(count: number | undefined = 1): void {
      for (let i = 0; i < count; i++) {
        messagesDelivered++;
        sessionMessageDelivered(session);
      }
    },
    end(reason: EndReason): void {
      if (endReason !== 'disconnected') endReason = reason;
    },
    responseEnded(reason: EndReason): void {
      responseEndAt ??= Date.now();
      endReason = reason;
    },
    outputBytes(bytes: number): void {
      bytesWritten += bytes;
    },
    finish(): void {
      if (finished) return;
      finished = true;
      const operationEndAt = Date.now();
      if (!responseEndAt && (!res || res.writableFinished)) responseEnded();
      if (res && res.statusCode >= 400 && endReason === 'done')
        endReason = 'error';
      const emit = (): void => {
        requestRecord(usage, {
          protocol,
          ...(tool ? { tool } : {}),
          stream,
          admissionWaitMs: admittedAt - startedAt,
          turnDurationMs: (turnEndAt ?? operationEndAt) - admittedAt,
          followDurationMs:
            turnEndAt === undefined ? 0 : operationEndAt - turnEndAt,
          endReason,
          responseEndAt: responseEndAt ?? operationEndAt,
          operationEndAt,
          messagesDelivered,
          bytesWritten,
        });
        res?.removeListener('socket', assigned);
        res?.removeListener('finish', responseEnded);
        res?.removeListener('close', responseEnded);
        releaseDelivery?.();
        requests.delete(req);
        if (res) responses.delete(res);
      };
      // MCP's SDK writes its response after the tool callback returns.
      if (res && !res.writableFinished && responseEndAt === undefined)
        complete = emit;
      else emit();
    },
  };
  requests.set(req, measurement);
  if (res) responses.set(res, measurement);
  return measurement;
}
