import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import {
  CollectionParty,
  ItemType,
  ManualPaymentMethod,
  ManualPaymentMethodType,
  ManualPaymentSubmission,
  ManualPaymentSubmissionStatus,
  Order,
  OrderStatus,
  PaymentChannel,
} from '../../src/payments/entities';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T111 / W7-C2: the manual-payment review queue must page, search and count on
 * the server. Seeds 110 old approved submissions and 5 newer open ones so every
 * assertion would break if the queue were still a client-side filter over the
 * first 100 rows.
 */
describe('manual payment review queue (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let seeded: { rows: ManualPaymentSubmission[]; orders: Order[]; student: User };

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    seeded = await seedQueue();
  });

  afterAll(async () => app.close());

  const financeAdmin = async (permissions: string[] = [...FINANCE_PERMISSIONS]) => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: permissions });
    return admin;
  };

  async function seedQueue() {
    const users = dataSource.getRepository(User);
    const student = await users.save(
      users.create({
        username: 'queue-student',
        name: 'Nadia Queue-Student',
        first_name: null,
        last_name: null,
        email: 'nadia.queue@example.test',
        phone: '01011112222',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const teacher = await users.save(
      users.create({
        username: 'queue-teacher',
        name: 'Queue Teacher',
        first_name: null,
        last_name: null,
        email: 'queue-teacher@example.test',
        phone: '01033334444',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const methods = dataSource.getRepository(ManualPaymentMethod);
    const method = await methods.save(
      methods.create({
        name: 'Queue Bank',
        type: ManualPaymentMethodType.BANK_TRANSFER,
        enabled: true,
        recipient_name: 'Platform',
        destination_details: { iban: 'EG000000' },
        instructions: 'pay here',
        currency: 'EGP',
        created_by: teacher.id,
        updated_by: teacher.id,
      }),
    );
    const orderRepo = dataSource.getRepository(Order);
    const subRepo = dataSource.getRepository(ManualPaymentSubmission);
    const total = 115;
    const orders: Order[] = [];
    for (let i = 1; i <= total; i += 1) {
      orders.push(
        orderRepo.create({
          order_number: `QUEUE-${String(i).padStart(4, '0')}`,
          student_id: student.id,
          teacher_id: teacher.id,
          item_type: ItemType.LESSON,
          item_id: randomUUID(),
          quantity: 1,
          original_amount_minor: 10_000,
          discount_amount_minor: 0,
          final_amount_minor: 10_000,
          refunded_amount_minor: 0,
          currency: 'EGP',
          payment_channel: PaymentChannel.MANUAL,
          payment_method: 'manual',
          status: OrderStatus.PENDING,
          discount_code_id: null,
          activation_code_id: null,
          payment_id: null,
          collection_party: CollectionParty.PLATFORM,
          product_title_snapshot: 'Queue lesson',
          product_title_ar_snapshot: null,
          seller_name_snapshot: null,
          platform_commission_bps: 3000,
          platform_commission_minor: 3000,
          teacher_earning_minor: 7000,
          discount_snapshot: null,
          metadata: null,
          expires_at: null,
          paid_at: null,
          cancelled_at: null,
        }),
      );
    }
    const savedOrders = await orderRepo.save(orders);
    const base = Date.UTC(2026, 0, 1);
    const rows: ManualPaymentSubmission[] = savedOrders.map((order, idx) => {
      const n = idx + 1;
      const open = n > 110;
      return subRepo.create({
        order_id: order.id,
        student_id: student.id,
        manual_payment_method_id: method.id,
        claimed_amount_minor: 10_000,
        currency: 'EGP',
        payer_name: `Payer ${n}`,
        payer_account_hint: null,
        transaction_reference: `REF-${String(n).padStart(4, '0')}`,
        paid_at_claimed: null,
        proof_file_key: null,
        proof_sha256: null,
        proof_mime_type: null,
        student_note: null,
        status: open
          ? ManualPaymentSubmissionStatus.SUBMITTED
          : ManualPaymentSubmissionStatus.APPROVED,
        submitted_at: new Date(base + n * 60_000),
        reviewed_by: null,
        reviewed_at: null,
        rejection_reason_code: null,
        rejection_reason: null,
        reviewer_note: null,
        revision_count: 0,
        // 3 of the 5 open rows carry risk flags
        metadata: n >= 113 ? { risk_flags: ['amount_mismatch'] } : null,
      });
    });
    const savedRows = await subRepo.save(rows);
    return { rows: savedRows, orders: savedOrders, student };
  }

  it('filters by status server-side and totals match the filtered set', async () => {
    const admin = await financeAdmin();
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ status: 'submitted', limit: 25 })
      .expect(200);
    const body = res.body as { data: Array<{ id: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(5);
    expect(body.data).toHaveLength(5);
  });

  it('stats count the whole backlog independent of any page size', async () => {
    const admin = await financeAdmin();
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions/stats`)
      .expect(200);
    expect((res.body as { data: unknown }).data).toEqual({
      pending: 5,
      under_review: 0,
      risk_flagged: 3,
    });
  });

  it('search finds a row beyond the first 100 by order number, reference and student name', async () => {
    const admin = await financeAdmin();
    const byOrder = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ search: 'QUEUE-0115' })
      .expect(200);
    const orderBody = byOrder.body as {
      data: Array<{ id: string; student: { id: string; name: string; email: string } | null }>;
      meta: { total: number };
    };
    expect(orderBody.meta.total).toBe(1);
    expect(orderBody.data[0]!.id).toBe(seeded.rows[114]!.id);
    expect(orderBody.data[0]!.student).toEqual({
      id: seeded.student.id,
      name: 'Nadia Queue-Student',
      email: 'nadia.queue@example.test',
    });

    const byRef = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ search: 'ref-0113' })
      .expect(200);
    expect((byRef.body as { meta: { total: number } }).meta.total).toBe(1);

    const byName = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ search: 'nadia queue-student', limit: 25 })
      .expect(200);
    // every seeded submission belongs to that student
    expect((byName.body as { meta: { total: number } }).meta.total).toBe(115);
    // a LIKE wildcard in user input is matched literally
    const wildcard = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ search: '%' })
      .expect(200);
    expect((wildcard.body as { meta: { total: number } }).meta.total).toBe(0);
  });

  it('pages deterministically with the oldest submission first', async () => {
    const admin = await financeAdmin();
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ page: 2, limit: 25 })
      .expect(200);
    const body = res.body as { data: Array<{ id: string }>; meta: { total: number; page: number } };
    expect(body.meta.total).toBe(115);
    expect(body.meta.page).toBe(2);
    expect(body.data.map((r) => r.id)).toEqual(seeded.rows.slice(25, 50).map((r) => r.id));
  });

  it('requires reports.view on both routes and rejects non-admins', async () => {
    const noPerms = await financeAdmin([]);
    await noPerms.agent.get(`${API_PREFIX}/admin/finance/manual-submissions`).expect(403);
    await noPerms.agent.get(`${API_PREFIX}/admin/finance/manual-submissions/stats`).expect(403);

    const teacher = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    await teacher.agent.get(`${API_PREFIX}/admin/finance/manual-submissions`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/admin/finance/manual-submissions/stats`).expect(403);
  });

  it('rejects limit above 100', async () => {
    const admin = await financeAdmin();
    await admin.agent
      .get(`${API_PREFIX}/admin/finance/manual-submissions`)
      .query({ limit: 101 })
      .expect(400);
  });
});
