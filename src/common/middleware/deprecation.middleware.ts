import { Injectable, NestMiddleware } from '@nestjs/common';

import { NextFunction, Request, Response } from 'express';

export interface DeprecationOptions {
  version: string;
  sunsetDate: string;
  successorPath?: string;
}

@Injectable()
export class DeprecationMiddleware implements NestMiddleware {
  constructor(private readonly options: DeprecationOptions) {}

  public use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-API-Deprecated', 'true');
    res.setHeader('X-API-Sunset-Date', this.options.sunsetDate);
    res.setHeader('X-API-Deprecated-Version', this.options.version);

    if (
      this.options.successorPath !== undefined &&
      this.options.successorPath !== ''
    ) {
      res.setHeader(
        'Link',
        `<${this.options.successorPath}>; rel="successor-version"`,
      );
    }

    next();
  }
}

export function deprecationWarning(
  version: string,
  sunsetDate: string,
  successorPath?: string,
): (req: Request, res: Response, next: NextFunction) => void {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-API-Deprecated', 'true');
    res.setHeader('X-API-Sunset-Date', sunsetDate);
    res.setHeader('X-API-Deprecated-Version', version);

    if (successorPath !== undefined && successorPath !== '') {
      res.setHeader('Link', `<${successorPath}>; rel="successor-version"`);
    }

    next();
  };
}
