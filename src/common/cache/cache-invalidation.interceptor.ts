import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { of, from } from 'rxjs';

import type {
  ApplicationCacheFamily,
  ApplicationCacheScopeInvalidation,
} from './application-cache.service';
import { ApplicationCacheService } from './application-cache.service';
import {
  INVALIDATES_CACHE_KEY,
  SKIP_CACHE_INVALIDATION_KEY,
  type CacheInvalidationTarget,
} from './cache-invalidation.decorator';

type InvalidationPlan =
  | { kind: 'skip' }
  | { kind: 'targets'; targets: readonly CacheInvalidationTarget[] }
  | { kind: 'all' };

interface InterceptedRequest {
  method?: string;
  user?: { userId?: unknown };
}

/**
 * A successful mutating API request advances the global cache generation
 * unless the route (or its controller) declares otherwise:
 *
 *  1. `@SkipCacheInvalidation()` — no bump (the route writes no cached table);
 *  2. `@InvalidatesCache([...])` — bump only the listed families, or only the
 *     principal's own slice of an owner-scoped family (`{family, scope: 'self'}`,
 *     resolved to `owner:<request.user.userId>` and never from params/body; with
 *     no principal it falls back to the whole family);
 *  3. undeclared — global bump, the correctness backstop for
 *     create/update/delete/status/bulk routes.
 *
 * A handler-level declaration overrides a class-level one; within one level
 * skip wins. Handler errors never invalidate. Failed cache invalidation is
 * observable but never turns a committed request into a 500.
 */
@Injectable()
export class CacheInvalidationInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CacheInvalidationInterceptor.name);

  public constructor(
    private readonly applicationCache: ApplicationCacheService,
    private readonly reflector: Reflector,
  ) {}

  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<InterceptedRequest>();
    const method = request.method;
    if (!method || ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      return next.handle();
    }

    const plan = this.resolvePlan(context);
    if (plan.kind === 'skip') {
      return next.handle();
    }

    return next.handle().pipe(
      mergeMap((value) =>
        from(this.invalidate(plan, request)).pipe(
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

  private resolvePlan(context: ExecutionContext): InvalidationPlan {
    // Most specific declaration wins: handler first, then the controller class.
    for (const target of [context.getHandler(), context.getClass()]) {
      if (this.reflector.get<boolean | undefined>(SKIP_CACHE_INVALIDATION_KEY, target) === true) {
        return { kind: 'skip' };
      }
      const targets = this.reflector.get<readonly CacheInvalidationTarget[] | undefined>(
        INVALIDATES_CACHE_KEY,
        target,
      );
      if (targets !== undefined) {
        return { kind: 'targets', targets };
      }
    }
    return { kind: 'all' };
  }

  private async invalidate(plan: InvalidationPlan, request: InterceptedRequest): Promise<void> {
    if (plan.kind !== 'targets') {
      await this.applicationCache.invalidateAll();
      return;
    }

    const families = new Set<ApplicationCacheFamily>();
    const scopes: ApplicationCacheScopeInvalidation[] = [];
    // The owner comes only from the authenticated principal, never from params or body.
    const userId = request.user?.userId;
    const principalId = typeof userId === 'string' && userId.length > 0 ? userId : undefined;

    for (const target of plan.targets) {
      if (typeof target === 'string') {
        families.add(target);
      } else if (principalId === undefined) {
        // No principal to scope by: widen to the family. Never skip.
        families.add(target.family);
      } else {
        scopes.push({ family: target.family, scope: `owner:${principalId}` });
      }
    }

    // A family-level bump already covers any scoped slice of the same family.
    const remainingScopes = scopes.filter(({ family }) => !families.has(family));
    await Promise.all([
      families.size > 0 ? this.applicationCache.invalidate([...families]) : undefined,
      remainingScopes.length > 0
        ? this.applicationCache.invalidateScopes(remainingScopes)
        : undefined,
    ]);
  }
}
