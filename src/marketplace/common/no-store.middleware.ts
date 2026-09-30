import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * FR-303, T208/T213. Every authenticated, instructor, admin and financial
 * marketplace response — including any response that may carry a
 * short-lived signed content URL — must never be cached by a browser,
 * proxy or CDN. Applied module-wide in `MarketplaceModule.configure()`,
 * excluding only the handful of genuinely public, anonymous catalogue GET
 * routes (which get their own explicit short public cache instead).
 */
@Injectable()
export class NoStoreMiddleware implements NestMiddleware {
  public use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  }
}
