import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..', '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/**
 * The deployment platform must gate traffic on READINESS, not liveness.
 *
 * `GET /api/v1/health` returns 200 unconditionally without touching PostgreSQL
 * or Redis (that is its correct liveness contract), so pointing a platform
 * health check at it means a deployment that cannot reach its database still
 * passes and receives traffic. `GET /api/v1/health/readiness` checks both.
 *
 * Asserted against the config files because that wiring is the whole fix — a
 * passing readiness endpoint nothing consults changes nothing.
 */
describe('deployment health check semantics', () => {
  it('Railway gates on the readiness endpoint', () => {
    const railway = JSON.parse(readRepoFile('railway.json')) as {
      deploy?: { healthcheckPath?: string };
    };

    expect(railway.deploy?.healthcheckPath).toBe('/api/v1/health/readiness');
  });

  it('Railway keeps a restart policy so a crash-looping process is replaced', () => {
    const railway = JSON.parse(readRepoFile('railway.json')) as {
      deploy?: { restartPolicyType?: string };
    };

    expect(railway.deploy?.restartPolicyType).toBe('ON_FAILURE');
  });
});
