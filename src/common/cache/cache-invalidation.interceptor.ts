import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { of, from } from 'rxjs';

import { ApplicationCacheService } from './application-cache.service';

/**
 * A successful mutating API request advances the global cache generation.
 * This is a correctness backstop for create/update/delete/status/bulk routes;
 * domain-specific callers may still invalidate a narrower family. Failed cache
 * invalidation is observable but never turns a committed request into a 500.
 */
@Injectable()
export class CacheInvalidationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheInvalidationInterceptor.name);

  public constructor(private readonly applicationCache: ApplicationCacheService) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const method = context.switchToHttp().getRequest<{ method?: string }>().method;
    if (!method || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap((value) =>
        from(this.applicationCache.invalidateAll()).pipe(
          catchError((error: unknown) => {
            this.logger.error(
              `Post-mutation cache invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return of(undefined);
          }),
          mergeMap(() => of(value)),
        ),
      ),
    );
  }
}
