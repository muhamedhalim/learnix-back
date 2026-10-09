import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  CollectionParty,
  ItemType,
  Order,
  OrderStatus,
  PaymentChannel,
} from '../../src/payments/entities';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

jest.setTimeout(120_000);

/**
 * T081 (W5-C8): order lists project only the consumed user columns and paginate in two statements.
 * Admin list: `student` -> {id,name,email}, `teacher` -> {id,name}. Student list: neither is returned.
 */
describe('Order list projection (postgres)', () => {
  let ctx: E2EContext;
  let counter: StatementCounter;

  beforeAll(async () => {
    ctx = await createE2EApp();
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  let seq = 0;

  async function teacher(): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `olp-teacher-${String(seq)}`,
        name: `Olp Teacher ${String(seq)}`,
        first_name: null,
        last_name: null,
        email: `olp-teacher-${String(seq)}@example.test`,
        phone: `0124${String(seq).padStart(7, '0')}`,
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function order(studentId: string, teacherId: string, title: string): Promise<Order> {
    seq += 1;
    const orders = ds().getRepository(Order);
    return orders.save(
      orders.create({
        order_number: `OLP-${String(seq)}-${randomUUID().slice(0, 6)}`,
        student_id: studentId,
        teacher_id: teacherId,
        item_type: ItemType.LESSON,
        item_id: teacherId,
        quantity: 1,
        original_amount_minor: 10_000,
        discount_amount_minor: 0,
        final_amount_minor: 10_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: 'paymob',
        status: OrderStatus.PAID,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: title,
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 3000,
        teacher_earning_minor: 7000,
        discount_snapshot: null,
        metadata: null,
        expires_at: null,
        paid_at: new Date(),
        cancelled_at: null,
      }),
    );
  }

  async function financeAdmin() {
    const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
    await ds()
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    return admin;
  }

  it('admin list: narrowed user columns, same totals, search by student email, two order statements', async () => {
    const admin = await financeAdmin();
    const t = await teacher();
    const s1 = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const s2 = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    for (let i = 0; i < 5; i += 1) await order(s1.userId, t.id, `Course ${String(i)}`);
    await order(s2.userId, t.id, 'Other course');

    counter.start();
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/finance/orders`)
      .query({ page: 2, limit: 4 })
      .set('X-Request-Id', 'olp-admin-list')
      .expect(200);
    counter.stop();

    expect(res.body.meta).toMatchObject({ page: 2, limit: 4, total: 6, totalPages: 2 });
    expect(res.body.data).toHaveLength(2);
    for (const row of res.body.data as Array<Record<string, unknown>>) {
      expect(Object.keys(row['student'] as object).sort()).toEqual(['email', 'id', 'name']);
      expect(Object.keys(row['teacher'] as object).sort()).toEqual(['id', 'name']);
      expect(row['teacher']).toMatchObject({ id: t.id });
    }
    // The permission guard's own reads are not part of this budget: count statements on the orders table.
    expect(counter.count({ requestId: 'olp-admin-list', table: 'orders' })).toBe(2);

    const me = await ds().getRepository(User).findOneByOrFail({ id: s2.userId });
    const search = await admin.agent
      .get(`${API_PREFIX}/admin/finance/orders`)
      .query({ search: me.email })
      .expect(200);
    expect(search.body.meta.total).toBe(1);
    expect(search.body.data[0].product_title_snapshot).toBe('Other course');
  });

  it('student list: only the caller orders, no student/teacher objects, two order statements', async () => {
    const t = await teacher();
    const mine = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    await order(mine.userId, t.id, 'Mine 1');
    await order(mine.userId, t.id, 'Mine 2');
    await order(other.userId, t.id, 'Not mine');

    counter.start();
    const res = await mine.agent
      .get(`${API_PREFIX}/payments/orders`)
      .set('X-Request-Id', 'olp-student-list')
      .expect(200);
    counter.stop();

    expect(res.body.meta.total).toBe(2);
    const titles = (res.body.data as Array<{ product_title_snapshot: string }>)
      .map((row) => row.product_title_snapshot)
      .sort();
    expect(titles).toEqual(['Mine 1', 'Mine 2']);
    for (const row of res.body.data as Array<Record<string, unknown>>) {
      expect(row).not.toHaveProperty('student');
      expect(row).not.toHaveProperty('teacher');
    }
    // A first page that is not full needs no count statement (TypeORM reuses the row count).
    expect(counter.count({ requestId: 'olp-student-list', table: 'orders' })).toBeLessThanOrEqual(
      2,
    );

    counter.start();
    const paged = await mine.agent
      .get(`${API_PREFIX}/payments/orders`)
      .query({ page: 1, limit: 1 })
      .set('X-Request-Id', 'olp-student-paged')
      .expect(200);
    counter.stop();
    expect(paged.body.meta).toMatchObject({ total: 2, totalPages: 2, hasNextPage: true });
    expect(paged.body.data).toHaveLength(1);
    expect(counter.count({ requestId: 'olp-student-paged', table: 'orders' })).toBe(2);
  });

  it('student list: search on the order title still works and never leaks other students', async () => {
    const t = await teacher();
    const mine = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    await order(mine.userId, t.id, 'Algebra');
    await order(mine.userId, t.id, 'Geometry');
    await order(other.userId, t.id, 'Algebra');

    const res = await mine.agent
      .get(`${API_PREFIX}/payments/orders`)
      .query({ search: 'algebra' })
      .expect(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].product_title_snapshot).toBe('Algebra');
  });

  it('student list: searching the caller own name still matches (the join exists only when searching)', async () => {
    const t = await teacher();
    const mine = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    await order(mine.userId, t.id, 'Anything');
    const me = await ds().getRepository(User).findOneByOrFail({ id: mine.userId });

    const res = await mine.agent
      .get(`${API_PREFIX}/payments/orders`)
      .query({ search: me.name })
      .expect(200);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).not.toHaveProperty('student');
  });
});
