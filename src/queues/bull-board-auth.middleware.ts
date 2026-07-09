import { Logger } from '@nestjs/common';

import basicAuth from 'express-basic-auth';

const logger = new Logger('BullBoardAuth');

/**
 * HTTP Basic Auth guard for the Bull Board dashboard (`/admin/queues`).
 *
 * The dashboard exposes queue internals (job payloads) and destructive actions
 * (retry / remove / promote), so it must never be reachable anonymously.
 *
 * Credentials come from `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD`. The
 * authorizer reads them per-request (so env loaded by ConfigModule is available)
 * and **fails closed**: when either variable is unset, every request is rejected
 * — the dashboard is inaccessible until credentials are configured.
 */
export function bullBoardAuthMiddleware(): ReturnType<typeof basicAuth> {
  return basicAuth({
    challenge: true,
    realm: 'BullBoard',
    authorizer: (username: string, password: string): boolean => {
      const expectedUser = process.env['BULL_BOARD_USER'];
      const expectedPassword = process.env['BULL_BOARD_PASSWORD'];

      if (
        expectedUser === undefined ||
        expectedUser === '' ||
        expectedPassword === undefined ||
        expectedPassword === ''
      ) {
        logger.warn(
          'Bull Board access denied: BULL_BOARD_USER / BULL_BOARD_PASSWORD are not configured.',
        );
        return false;
      }

      // Constant-time comparison to avoid credential timing attacks.
      const userMatches = basicAuth.safeCompare(username, expectedUser);
      const passwordMatches = basicAuth.safeCompare(password, expectedPassword);
      return Boolean(userMatches) && Boolean(passwordMatches);
    },
  });
}
