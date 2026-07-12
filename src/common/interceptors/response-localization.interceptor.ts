import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';

import type { Request } from 'express';
import { map, Observable } from 'rxjs';

import { resolveRequestLocale, translateBody } from '../../i18n/error-translator.util';

/**
 * Companion to `HttpExceptionFilter`'s error-path translation: some
 * successful responses also carry a human-readable `message` field (e.g.
 * "Registration request received. Pending approval"). Those are authored
 * with `biBody(en, ar)` at the call site — `{ message, message_ar }`; this
 * interceptor resolves the requester's locale the same way the exception
 * filter does and picks the right side before the JSON body is sent,
 * dropping `message_ar`. Bodies without that shape pass through untouched.
 */
@Injectable()
export class ResponseLocalizationInterceptor implements NestInterceptor {
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const locale = resolveRequestLocale(request);

    return next.handle().pipe(
      map((body: unknown) => {
        if (typeof body === 'object' && body !== null) {
          return translateBody(body as Record<string, unknown>, locale);
        }
        return body;
      }),
    );
  }
}
