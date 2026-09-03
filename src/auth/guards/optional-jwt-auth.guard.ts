import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * The public catalogue's own need (FR-090): a course detail page must show
 * an authenticated learner's existing enrollment instead of a buy control,
 * while staying fully reachable with no token at all. Reuses the same
 * `'jwt'` passport strategy `JwtAuthGuard` does — the only difference is
 * `handleRequest` never rejects, so a missing or invalid token simply
 * leaves `request.user` unset rather than failing the request.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  public override handleRequest<TUser = unknown>(_err: unknown, user: TUser): TUser | null {
    return user || null;
  }
}
