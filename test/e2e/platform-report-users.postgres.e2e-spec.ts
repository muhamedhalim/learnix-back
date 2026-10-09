import { Between, IsNull } from 'typeorm';

import { ReportsService } from '../../src/reports/reports.service';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * T059(c): the five user counts of `getPlatformUserStats` are one statement now.
 * The reference below is the former implementation (five `count()` calls); the
 * fixture has soft-deleted users of each role and users created exactly on the
 * inclusive range boundaries.
 */
describe('Platform report user counts (parity, postgres)', () => {
  let ctx: E2EContext;
  let service: ReportsService;
  let counter: StatementCounter;

  beforeAll(async () => {
    ctx = await createE2EApp();
    service = ctx.app.get(ReportsService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const stats = (range: { startDate: Date; endDate: Date }) =>
    (
      service as unknown as {
        getPlatformUserStats: (r: { startDate: Date; endDate: Date }) => Promise<{
          totalUsers: number;
          students: number;
          teachers: number;
          admins: number;
          newUsers: number;
          activeUsers: number;
        }>;
      }
    ).getPlatformUserStats(range);

  async function make(role: UserRole, tag: string, createdAt: Date, deleted = false) {
    const users = ctx.dataSource.getRepository(User);
    const saved = await users.save(
      users.create({
        username: `pr-${tag}`,
        name: tag,
        first_name: null,
        last_name: null,
        email: `pr-${tag}@example.test`,
        phone: `0113${Math.floor(1_000_000 + Math.random() * 8_999_999).toString()}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
        created_at: createdAt,
      } as never),
    );
    await ctx.dataSource.query('UPDATE users SET created_at = $1 WHERE id = $2', [createdAt, saved.id]);
    if (deleted) await users.softDelete({ id: saved.id });
  }

  async function legacy(range: { startDate: Date; endDate: Date }) {
    const users = ctx.dataSource.getRepository(User);
    return {
      totalUsers: await users.count({ where: { deleted_at: IsNull() } }),
      students: await users.count({ where: { role: UserRole.STUDENT, deleted_at: IsNull() } }),
      teachers: await users.count({ where: { role: UserRole.TEACHER, deleted_at: IsNull() } }),
      admins: await users.count({ where: { role: UserRole.ADMIN, deleted_at: IsNull() } }),
      newUsers: await users.count({
        where: { created_at: Between(range.startDate, range.endDate), deleted_at: IsNull() },
      }),
    };
  }

  it('matches the former five counts, with inclusive range boundaries and soft-deleted users excluded', async () => {
    const start = new Date('2026-03-01T00:00:00.000Z');
    const end = new Date('2026-03-31T23:59:59.000Z');
    const before = new Date('2026-02-28T23:59:59.000Z');
    const after = new Date('2026-04-01T00:00:00.000Z');

    await make(UserRole.STUDENT, 's-on-start', start);
    await make(UserRole.STUDENT, 's-on-end', end);
    await make(UserRole.STUDENT, 's-before', before);
    await make(UserRole.STUDENT, 's-after', after);
    await make(UserRole.TEACHER, 't-inside', new Date('2026-03-15T12:00:00.000Z'));
    await make(UserRole.ADMIN, 'a-inside', new Date('2026-03-16T12:00:00.000Z'));
    await make(UserRole.STUDENT, 's-deleted', new Date('2026-03-10T00:00:00.000Z'), true);
    await make(UserRole.TEACHER, 't-deleted', new Date('2026-03-10T00:00:00.000Z'), true);
    await make(UserRole.ADMIN, 'a-deleted', new Date('2026-03-10T00:00:00.000Z'), true);

    const range = { startDate: start, endDate: end };
    const actual = await stats(range);
    const expected = await legacy(range);

    expect(actual).toMatchObject(expected);
    // Fixture sanity: boundaries and soft-deletes were really exercised.
    expect(expected.newUsers).toBe(4); // start, end, teacher, admin; not before/after/deleted
    expect(expected.students).toBe(4);
    expect(expected.totalUsers).toBe(6);
    expect(actual.activeUsers).toBe(0);
  });

  it('costs two statements (users counts + active users) instead of six', async () => {
    await make(UserRole.STUDENT, 's1', new Date());
    counter.start();
    await stats({ startDate: new Date(Date.now() - 86_400_000), endDate: new Date() });
    expect(counter.stop().length).toBe(2);
  });
});
