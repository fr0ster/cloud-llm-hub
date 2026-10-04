/**
 * The raw route's error path, end to end through `handleStreamHTTP`: a
 * refused request is answered with its own status and a body that names it —
 * never "Internal Server Error" for a 4xx.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

jest.mock(
  '@sap/cds',
  () => {
    const log = () => ({ info() {}, warn() {}, error() {}, debug() {} });
    return {
      __esModule: true,
      default: {
        log,
        on: () => {},
        context: {
          user: { id: 'alice', is: (role: string) => role !== 'system-user' },
        },
      },
      log,
    };
  },
  { virtual: true },
);

import type { Request, Response } from 'express';
import { handleStreamHTTP } from '../../srv/server';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handleStreamHTTP(
      req as unknown as Request,
      res as unknown as Response,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

it('a bad x-sap-system-type is answered 400 "Bad Request: …"', async () => {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-sap-url': 'https://sap.example.invalid',
      'x-sap-auth-type': 'basic',
      'x-sap-login': 'developer',
      'x-sap-password': 'secret',
      'x-sap-system-type': 'bogus',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const text = await res.text();
  expect(res.status).toBe(400);
  expect(text).toMatch(
    /^Bad Request: Header x-sap-system-type must be one of onprem, cloud, legacy/,
  );
  expect(text).not.toMatch(/Internal Server Error/);
});
