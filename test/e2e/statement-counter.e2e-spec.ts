import { createE2EApp, type E2EContext } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * Self-test for the test-only `StatementCounter` helper (spec 004, T003).
 *
 * The probes read `information_schema`, which no application code path touches at runtime, so the
 * table-filtered counts stay deterministic even though the app under test is live (cron, queue
 * workers and post-commit listeners may issue their own statements inside the window).
 */
describe('StatementCounter (e2e helper self-test)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('counts one known single-statement query as exactly 1, and ignores statements outside the window', async () => {
    const probe = 'SELECT 1 FROM information_schema.tables LIMIT 1';
    const counter = new StatementCounter(ctx.dataSource);

    await ctx.dataSource.query(probe); // before start(): not counted
    counter.start();
    await ctx.dataSource.query(probe);
    counter.stop();
    await ctx.dataSource.query(probe); // after stop(): not counted

    expect(counter.count({ table: 'information_schema.tables' })).toBe(1);
  });

  it('filters by table name without matching longer identifiers', async () => {
    const counter = new StatementCounter(ctx.dataSource);

    counter.start();
    await ctx.dataSource.query('SELECT 1 FROM information_schema.tables LIMIT 1');
    counter.stop();

    expect(counter.count({ table: 'tables' })).toBe(1);
    expect(counter.count({ table: 'table' })).toBe(0);
    expect(counter.count({ table: 'user_sessions' })).toBe(0);
  });
});
