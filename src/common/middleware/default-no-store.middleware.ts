import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * T042 (W1-C9, Step 0). Owner decision (T010, Muhamed Halim, 2026-09-23): no
 * CDN, default branch only, header value `private, no-store`. Applied
 * app-wide from the root module so every response is `private, no-store`
 * unless a route explicitly opts out — the safe default for an app
 * dominated by authenticated, ownership-scoped and signed-content data.
 *
 * `marketplace/*` is excluded: `MarketplaceModule` already owns its own
 * `NoStoreMiddleware` (plain `no-store`, no `private`) with its own,
 * separately-decided exclusions for the public anonymous catalogue surface
 * (`gates/W1-C6d.md`/T042's own "Default branch" text) — this default does
 * not touch that namespace at all, so neither module has to reason about
 * cross-module middleware ordering.
 */
@Injectable()
export class DefaultNoStoreMiddleware implements NestMiddleware {
  public use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  }
}
