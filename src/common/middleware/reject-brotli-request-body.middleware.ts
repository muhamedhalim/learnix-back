import type { NextFunction, Request, Response } from 'express';

/**
 * Express 5's body-parser decompresses request bodies by `Content-Encoding`, including `br`, before any
 * guard or throttler runs, which hands the runtime's Brotli decoder to unauthenticated input
 * (CVE-2026-111497, fixed in Node.js 24.22.1). No client of this API sends brotli request bodies (browsers
 * never compress requests; webhook senders use identity), so they are refused outright with 415 and the
 * body is never read. gzip/deflate stay accepted. Registered with `app.use` before `listen()`, so it runs
 * ahead of the parsers Nest installs in `init()`.
 */
export function rejectBrotliRequestBodies(req: Request, res: Response, next: NextFunction): void {
  const encoding = req.headers['content-encoding'];
  if (encoding === undefined) {
    next();
    return;
  }

  const codings = encoding
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== '');
  if (!codings.includes('br')) {
    next();
    return;
  }

  res.setHeader('Connection', 'close');
  res.status(415).json({
    type: 'about:blank',
    title: 'Unsupported Media Type',
    status: 415,
    detail: 'Content-Encoding "br" is not accepted for request bodies.',
    code: 'UNSUPPORTED_CONTENT_ENCODING',
  });
}
