import 'reflect-metadata';

import { AppEnvironment } from '../../config/app-env';
import { shouldWarnOnEnvironmentMismatch } from './external-providers.indicator';

/**
 * Regression coverage for docs/NODE_ENV_AUDIT.md #18/#20.
 *
 * Before the fix, this warning was gated on `NODE_ENV === 'production'`. Since
 * staging deliberately runs `NODE_ENV=production` (it needs every protection
 * that flag turns on), and its real `FRONTEND_URL`
 * (`https://staging.learnix.school`) is classified as non-production by
 * `environmentForUrl`, the warning fired on EVERY health check staging ever
 * ran. These tests reproduce the bug against the old (NODE_ENV-keyed) logic and
 * prove the new (APP_ENV-keyed) logic no longer exhibits it.
 */
describe('shouldWarnOnEnvironmentMismatch', () => {
  it('warns when a genuine production deployment has a non-production-looking URL', () => {
    expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Production, 'sandbox')).toBe(true);
    expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Production, 'local')).toBe(true);
  });

  it('does NOT warn on a genuine production deployment with a production URL', () => {
    expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Production, 'production')).toBe(false);
  });

  it('THE BUG FIX: does not warn on staging even though its FRONTEND_URL looks like "sandbox"', () => {
    // This is staging's real, correct, everyday configuration: APP_ENV=staging,
    // NODE_ENV=production, FRONTEND_URL=https://staging.learnix.school (which
    // environmentForUrl() classifies as 'sandbox' because it contains
    // "staging"). Under the old NODE_ENV-keyed check this combination produced
    // a permanent false-positive warning on every health check.
    expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Staging, 'sandbox')).toBe(false);
  });

  it('does not warn on development or test regardless of the URL shape', () => {
    expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Development, 'local')).toBe(false);
    expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Test, 'sandbox')).toBe(false);
  });

  describe('what the OLD, buggy NODE_ENV-keyed logic would have done (documentation only)', () => {
    /** The exact predicate that used to live inline in checkFrontend/checkPaymentGateway. */
    function oldBuggyLogic(nodeEnv: string | undefined, urlEnvironment: string): boolean {
      return nodeEnv === 'production' && urlEnvironment !== 'production';
    }

    it('would have raised a false-positive warning for staging', () => {
      // Staging's actual NODE_ENV value is 'production' (see config/app-env.ts
      // for why), and its FRONTEND_URL is classified 'sandbox'.
      expect(oldBuggyLogic('production', 'sandbox')).toBe(true); // ← the bug
      // The new logic, given the same real-world inputs mapped through
      // resolveAppEnv, correctly does not:
      expect(shouldWarnOnEnvironmentMismatch(AppEnvironment.Staging, 'sandbox')).toBe(false);
    });
  });
});
