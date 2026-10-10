import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';

import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

export interface PlaybackCookie {
  name: string;
  value: string;
  path: string;
  expires: Date;
}

export interface SigningCredentials {
  keyPairId: string;
  privateKey: string;
  algorithm?: 'SHA1' | 'SHA256';
}

/**
 * CloudFront signed cookies granting read access to ONE asset's files for `ttlSeconds`:
 * a custom policy whose resource is `<origin>/video/<assetId>/*`. Cookies are scoped to
 * that path, so access to one lesson never grants another.
 */
export function buildPlaybackCookies(
  creds: SigningCredentials,
  origin: string,
  assetId: string,
  ttlSeconds: number,
  now: Date = new Date(),
): { cookies: PlaybackCookie[]; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const policy = JSON.stringify({
    Statement: [
      {
        Resource: `${origin}/video/${assetId}/*`,
        Condition: { DateLessThan: { 'AWS:EpochTime': Math.floor(expiresAt.getTime() / 1000) } },
      },
    ],
  });
  const signed = getSignedCookies({
    keyPairId: creds.keyPairId,
    privateKey: creds.privateKey,
    policy,
    ...(creds.algorithm === 'SHA256' ? { algorithm: 'SHA256' as const } : {}),
  });
  const path = `/video/${assetId}/`;
  const cookies: PlaybackCookie[] = Object.entries(signed)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => ({ name, value: String(value), path, expires: expiresAt }));
  return { cookies, expiresAt };
}

/**
 * Lets any route return `{ ..., playback_cookies: PlaybackCookie[] }` and have them sent as
 * Set-Cookie headers (HttpOnly, Secure, SameSite=Lax, path-scoped, host-only), then removed from
 * the JSON body. Keeps cookie handling in one place instead of every controller taking `@Res()`.
 */
@Injectable()
export class PlaybackCookiesInterceptor implements NestInterceptor {
  public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (typeof body !== 'object' || body === null) return body;
        const record = body as Record<string, unknown>;
        const cookies = record['playback_cookies'] as PlaybackCookie[] | undefined;
        if (!Array.isArray(cookies)) return body;
        for (const cookie of cookies) {
          res.cookie(cookie.name, cookie.value, {
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: true,
            secure: true,
            sameSite: 'lax',
          });
        }
        const { playback_cookies: _omit, ...rest } = record;
        return rest;
      }),
    );
  }
}
