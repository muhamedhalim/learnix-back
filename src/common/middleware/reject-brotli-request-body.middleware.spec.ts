import { brotliCompressSync, gzipSync } from 'node:zlib';

import express from 'express';
import request from 'supertest';

import { rejectBrotliRequestBodies } from './reject-brotli-request-body.middleware';

/**
 * Exercises the real Express 5 / body-parser stack in the order main.ts produces: this middleware first,
 * then `express.json()` (what Nest registers in `init()`). The handler counts bodies that reached it.
 */
function buildApp() {
  const parsed: unknown[] = [];
  const app = express();
  app.use(rejectBrotliRequestBodies);
  app.use(express.json());
  app.post('/echo', (req, res) => {
    parsed.push(req.body);
    res.status(200).json({ received: req.body });
  });
  return { app, parsed };
}

const payload = JSON.stringify({ hello: 'world' });

/** Posts exact bytes as JSON: superagent would otherwise re-serialize a Buffer body. */
function postRaw(app: express.Express, encoding: string, body: Buffer | string) {
  return request(app)
    .post('/echo')
    .set('Content-Type', 'application/json')
    .set('Content-Encoding', encoding)
    .serialize((data: unknown) => data as string)
    .send(body as unknown as string);
}

describe('rejectBrotliRequestBodies', () => {
  it('control: without it, the Express 5 body parser decodes brotli request bodies', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo', (req, res) => res.status(200).json({ received: req.body }));

    const response = await postRaw(app, 'br', brotliCompressSync(payload));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: { hello: 'world' } });
  });

  it.each(['br', 'BR', ' br ', 'gzip, br', 'br,gzip'])(
    'refuses Content-Encoding %p with 415 before the body parser decodes it',
    async (encoding) => {
      const { app, parsed } = buildApp();

      const response = await postRaw(app, encoding, brotliCompressSync(payload));

      expect(response.status).toBe(415);
      expect(response.body).toMatchObject({ status: 415, code: 'UNSUPPORTED_CONTENT_ENCODING' });
      expect(parsed).toHaveLength(0);
    },
  );

  it('never feeds a malformed brotli stream to the decoder', async () => {
    const { app, parsed } = buildApp();

    const response = await postRaw(
      app,
      'br',
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x13, 0x37]),
    );

    expect(response.status).toBe(415);
    expect(parsed).toHaveLength(0);
  });

  it('still accepts identity bodies', async () => {
    const { app, parsed } = buildApp();

    const response = await request(app).post('/echo').send({ hello: 'world' });

    expect(response.status).toBe(200);
    expect(parsed).toEqual([{ hello: 'world' }]);
  });

  it('still accepts gzip bodies', async () => {
    const { app, parsed } = buildApp();

    const response = await postRaw(app, 'gzip', gzipSync(payload));

    expect(response.status).toBe(200);
    expect(parsed).toEqual([{ hello: 'world' }]);
  });

  it('does not treat encodings that merely contain "br" as brotli', async () => {
    const { app } = buildApp();

    const response = await postRaw(app, 'xbr', payload);

    // body-parser itself rejects the unknown coding; the point is this middleware did not answer it.
    expect(response.status).toBe(415);
    expect(response.body).not.toMatchObject({ code: 'UNSUPPORTED_CONTENT_ENCODING' });
  });
});
