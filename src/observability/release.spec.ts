import { resolveCommitSha, resolveRelease, resolveServiceVersion } from './release';

function reader(values: Record<string, string | undefined>) {
  return (key: string): string | undefined => values[key];
}

describe('release resolution', () => {
  it('prefers an explicit SENTRY_RELEASE over everything else', () => {
    expect(
      resolveRelease(
        reader({
          SENTRY_RELEASE: 'v1.2.3',
          APP_VERSION: '9.9.9',
          RAILWAY_GIT_COMMIT_SHA: 'deadbeef',
        }),
      ),
    ).toBe('v1.2.3');
  });

  it('falls back to APP_VERSION when SENTRY_RELEASE is unset', () => {
    expect(resolveRelease(reader({ APP_VERSION: '1.4.2', GIT_COMMIT: 'abc123' }))).toBe('1.4.2');
  });

  it('falls back to the platform commit SHA so Railway deploys are tagged without configuration', () => {
    expect(resolveRelease(reader({ RAILWAY_GIT_COMMIT_SHA: 'abc123def' }))).toBe('abc123def');
  });

  it('resolves the same value from a Vercel SHA, so a frontend and backend built from one commit correlate', () => {
    const sha = '0f1e2d3c4b5a';
    expect(resolveRelease(reader({ RAILWAY_GIT_COMMIT_SHA: sha }))).toBe(
      resolveRelease(reader({ VERCEL_GIT_COMMIT_SHA: sha })),
    );
  });

  it('returns undefined rather than inventing a release when nothing identifies the build', () => {
    expect(resolveRelease(reader({}))).toBeUndefined();
  });

  it('ignores empty and whitespace-only values', () => {
    expect(resolveRelease(reader({ SENTRY_RELEASE: '   ', APP_VERSION: '' }))).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(resolveRelease(reader({ SENTRY_RELEASE: '  v2.0.0 ' }))).toBe('v2.0.0');
  });

  it('reports the commit SHA separately from a human-readable release', () => {
    const env = reader({ APP_VERSION: '1.4.2', RAILWAY_GIT_COMMIT_SHA: 'sha-9' });
    expect(resolveRelease(env)).toBe('1.4.2');
    expect(resolveCommitSha(env)).toBe('sha-9');
  });

  it('keeps the historical 0.0.1 display fallback when nothing is configured', () => {
    expect(resolveServiceVersion(reader({}))).toBe('0.0.1');
  });

  it('uses the release as the display version when only a SHA is available', () => {
    expect(resolveServiceVersion(reader({ RAILWAY_GIT_COMMIT_SHA: 'sha-9' }))).toBe('sha-9');
  });
});
