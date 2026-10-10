import { resolveProcessRole, runsBackgroundWork } from './process-role';

const reader = (env: Record<string, string | undefined>) => (key: string) => env[key];

describe('process role', () => {
  it('defaults to all (historical single-process behaviour)', () => {
    expect(resolveProcessRole(reader({}))).toBe('all');
    expect(resolveProcessRole(reader({ PROCESS_ROLE: '  ' }))).toBe('all');
    expect(runsBackgroundWork(reader({}))).toBe(true);
  });

  it.each([
    ['api', false],
    ['worker', true],
    ['all', true],
    ['WORKER', true],
  ])('PROCESS_ROLE=%s -> background work %s', (role, expected) => {
    expect(runsBackgroundWork(reader({ PROCESS_ROLE: role }))).toBe(expected);
  });

  it('rejects unknown roles instead of silently running everything', () => {
    expect(() => resolveProcessRole(reader({ PROCESS_ROLE: 'cron' }))).toThrow(/PROCESS_ROLE/);
  });
});
