import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { API_PREFIX, createE2EApp } from './fixtures';

/**
 * E2E-2 regression (spec 005). `omr.e2e-spec.ts` once failed with `read ECONNRESET` on a request
 * that never reached the app: it ran inside a `Promise.all` with another request, and the e2e app
 * was never listening, so supertest bound and closed an ephemeral server per request — the first
 * request to finish closed the server, and Node's `close()` dropped the other request's idle
 * connection. The factory now listens once for the app's lifetime; these tests pin that down
 * deterministically (no timing window to hit or miss).
 */
describe('e2e harness — HTTP server lifecycle', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createE2EApp());
  });
  afterAll(async () => app.close());

  function openIdleConnection(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => resolve(socket));
      socket.once('error', reject);
    });
  }

  function sendOn(socket: Socket, path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let raw = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        raw += chunk;
        if (raw.includes('\r\n\r\n')) resolve(raw.split('\r\n')[0]!);
      });
      socket.once('error', reject);
      socket.once('close', () =>
        reject(new Error(`connection closed before a response; got: ${raw}`)),
      );
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
  }

  it('is already listening when the factory returns', () => {
    const address = app.getHttpServer().address() as AddressInfo | null;
    expect(address).not.toBeNull();
    expect(address!.address).toBe('127.0.0.1');
    expect(address!.port).toBeGreaterThan(0);
  });

  it('keeps an idle connection usable after another supertest request completes', async () => {
    const { port } = app.getHttpServer().address() as AddressInfo;
    const idle = await openIdleConnection(port);
    try {
      // A complete request/response cycle through supertest, while `idle` is open but silent —
      // exactly the state the reset OMR request was in.
      await request(app.getHttpServer()).get(`${API_PREFIX}/__e2e-harness-probe`).expect(404);

      await expect(sendOn(idle, `${API_PREFIX}/__e2e-harness-probe`)).resolves.toMatch(
        /^HTTP\/1\.1 404 /,
      );
    } finally {
      idle.destroy();
    }
  });
});
