import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of, throwError } from 'rxjs';

import {
  INVALIDATES_CACHE_KEY,
  InvalidatesCache,
  SKIP_CACHE_INVALIDATION_KEY,
  SkipCacheInvalidation,
} from './cache-invalidation.decorator';
import { CacheInvalidationInterceptor } from './cache-invalidation.interceptor';
import type { ApplicationCacheService } from './application-cache.service';

class Unmarked {
  public plain(): void {}

  @SkipCacheInvalidation()
  public skipped(): void {}

  @InvalidatesCache(['marketplace_catalog'])
  public declared(): void {}

  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  public declaredTwo(): void {}

  @InvalidatesCache([{ family: 'student_report', scope: 'self' }])
  public selfScoped(): void {}

  @InvalidatesCache([{ family: 'student_report', scope: 'self' }, 'platform_report'])
  public selfAndFamily(): void {}

  @InvalidatesCache([{ family: 'student_report', scope: 'self' }, 'student_report'])
  public selfAndSameFamily(): void {}
}

@InvalidatesCache(['student_report'])
class ClassDeclared {
  public inherits(): void {}

  @SkipCacheInvalidation()
  public skipOverride(): void {}

  @InvalidatesCache(['platform_report'])
  public declaredOverride(): void {}
}

@SkipCacheInvalidation()
class ClassSkipped {
  public inherits(): void {}

  @InvalidatesCache(['marketplace_catalog'])
  public declaredOverride(): void {}
}

function createContext(
  method: string,
  klass: new () => object,
  handlerName: string,
  user?: unknown,
): ExecutionContext {
  const handler = (klass.prototype as Record<string, () => void>)[handlerName] as () => void;
  return {
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as ExecutionContext;
}

describe('CacheInvalidationInterceptor', () => {
  let invalidateAll: jest.Mock;
  let invalidate: jest.Mock;
  let invalidateScopes: jest.Mock;
  let interceptor: CacheInvalidationInterceptor;

  const run = async (
    method: string,
    klass: new () => object,
    handlerName: string,
    handle: () => ReturnType<CallHandler['handle']> = () => of('result'),
    user?: unknown,
  ): Promise<unknown> => {
    const next: CallHandler = { handle };
    return await firstValueFrom(
      interceptor.intercept(createContext(method, klass, handlerName, user), next),
    );
  };

  beforeEach(() => {
    invalidateAll = jest.fn().mockResolvedValue(undefined);
    invalidate = jest.fn().mockResolvedValue(undefined);
    invalidateScopes = jest.fn().mockResolvedValue(undefined);
    interceptor = new CacheInvalidationInterceptor(
      { invalidateAll, invalidate, invalidateScopes } as unknown as ApplicationCacheService,
      new Reflector(),
    );
  });

  it('keeps the global bump for an undeclared successful mutation', async () => {
    await expect(run('POST', Unmarked, 'plain')).resolves.toBe('result');
    expect(invalidateAll).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it.each(['PUT', 'PATCH', 'DELETE'])(
    'keeps the global bump for an undeclared %s',
    async (method) => {
      await run(method, Unmarked, 'plain');
      expect(invalidateAll).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS'])('never invalidates on %s', async (method) => {
    await run(method, Unmarked, 'plain');
    expect(invalidateAll).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('does not invalidate anything for a @SkipCacheInvalidation() handler', async () => {
    await expect(run('POST', Unmarked, 'skipped')).resolves.toBe('result');
    expect(invalidateAll).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates only the declared families, not the global generation', async () => {
    await run('POST', Unmarked, 'declared');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(['marketplace_catalog']);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('invalidates every declared family in one call', async () => {
    await run('PATCH', Unmarked, 'declaredTwo');
    expect(invalidate).toHaveBeenCalledWith(['marketplace_catalog', 'admin_dashboard']);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('never invalidates when the handler throws', async () => {
    await expect(
      run('POST', Unmarked, 'plain', () => throwError(() => new Error('boom'))),
    ).rejects.toThrow('boom');
    await expect(
      run('POST', Unmarked, 'declared', () => throwError(() => new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(invalidateAll).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('returns the handler result even when invalidation fails', async () => {
    invalidateAll.mockRejectedValueOnce(new Error('redis down'));
    invalidate.mockRejectedValueOnce(new Error('redis down'));
    await expect(run('POST', Unmarked, 'plain')).resolves.toBe('result');
    await expect(run('POST', Unmarked, 'declared')).resolves.toBe('result');
  });

  describe('self-scoped declarations', () => {
    it('scopes to the authenticated principal only', async () => {
      await run('POST', Unmarked, 'selfScoped', undefined, { userId: 'student-a' });
      expect(invalidateScopes).toHaveBeenCalledWith([
        { family: 'student_report', scope: 'owner:student-a' },
      ]);
      expect(invalidate).not.toHaveBeenCalled();
      expect(invalidateAll).not.toHaveBeenCalled();
    });

    it('widens to the whole family, never skips, when there is no principal', async () => {
      await run('POST', Unmarked, 'selfScoped');
      expect(invalidate).toHaveBeenCalledWith(['student_report']);
      expect(invalidateScopes).not.toHaveBeenCalled();
    });

    it.each([{ userId: '' }, { userId: 42 }, {}, null])(
      'treats an unusable principal %p as no principal',
      async (user) => {
        await run('POST', Unmarked, 'selfScoped', undefined, user);
        expect(invalidate).toHaveBeenCalledWith(['student_report']);
        expect(invalidateScopes).not.toHaveBeenCalled();
      },
    );

    it('mixes scoped and family-level targets in one request', async () => {
      await run('POST', Unmarked, 'selfAndFamily', undefined, { userId: 'student-a' });
      expect(invalidate).toHaveBeenCalledWith(['platform_report']);
      expect(invalidateScopes).toHaveBeenCalledWith([
        { family: 'student_report', scope: 'owner:student-a' },
      ]);
    });

    it('lets a family-level target subsume a scoped target of the same family', async () => {
      await run('POST', Unmarked, 'selfAndSameFamily', undefined, { userId: 'student-a' });
      expect(invalidate).toHaveBeenCalledWith(['student_report']);
      expect(invalidateScopes).not.toHaveBeenCalled();
    });

    it('never invalidates a self-scoped route when the handler throws', async () => {
      await expect(
        run('POST', Unmarked, 'selfScoped', () => throwError(() => new Error('boom')), {
          userId: 'a',
        }),
      ).rejects.toThrow('boom');
      expect(invalidateScopes).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  describe('class-level declarations', () => {
    it('applies a class-level declaration to handlers with none of their own', async () => {
      await run('POST', ClassDeclared, 'inherits');
      expect(invalidate).toHaveBeenCalledWith(['student_report']);
      expect(invalidateAll).not.toHaveBeenCalled();
    });

    it('lets a handler-level skip override a class-level declaration', async () => {
      await run('POST', ClassDeclared, 'skipOverride');
      expect(invalidate).not.toHaveBeenCalled();
      expect(invalidateAll).not.toHaveBeenCalled();
    });

    it('lets a handler-level declaration override a class-level declaration', async () => {
      await run('POST', ClassDeclared, 'declaredOverride');
      expect(invalidate).toHaveBeenCalledWith(['platform_report']);
    });

    it('applies a class-level skip to handlers with none of their own', async () => {
      await run('POST', ClassSkipped, 'inherits');
      expect(invalidate).not.toHaveBeenCalled();
      expect(invalidateAll).not.toHaveBeenCalled();
    });

    it('lets a handler-level declaration override a class-level skip', async () => {
      await run('POST', ClassSkipped, 'declaredOverride');
      expect(invalidate).toHaveBeenCalledWith(['marketplace_catalog']);
    });
  });
});

describe('cache invalidation decorators', () => {
  it('rejects an empty family list at decoration time', () => {
    expect(() => InvalidatesCache([])).toThrow(/at least one target/);
  });

  it('stores metadata under stable keys', () => {
    const reflector = new Reflector();
    expect(reflector.get(SKIP_CACHE_INVALIDATION_KEY, Unmarked.prototype.skipped)).toBe(true);
    expect(reflector.get(INVALIDATES_CACHE_KEY, Unmarked.prototype.declaredTwo)).toEqual([
      'marketplace_catalog',
      'admin_dashboard',
    ]);
    expect(reflector.get(SKIP_CACHE_INVALIDATION_KEY, Unmarked.prototype.plain)).toBeUndefined();
  });
});
