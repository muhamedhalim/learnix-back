import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import {
  CollectionParty,
  ItemType,
  Order,
  OrderStatus,
  PaymentAuditLog,
  PaymentChannel,
  Refund,
  RefundStatus,
  Settlement,
  SettlementStatus,
} from '../../src/payments/entities';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * `GET /admin/finance/audit` is the only read path over `payment_audit_logs`
 * outside a single settlement's details, so its teacher scoping is a security
 * boundary: one teacher's payout and refund history must never surface under
 * another teacher's id.
 */
describe('teacher finance audit trail (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let server: Server;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  const makeTeacher = async (suffix: string): Promise<User> => {
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({
        username: `audit-teacher-${suffix}`,
        name: `Audit Teacher ${suffix}`,
        first_name: null,
        last_name: null,
        email: `audit-teacher-${suffix}@example.test`,
        phone: `0100000${suffix.padStart(4, '0')}`,
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  };

  const makeStudent = async (): Promise<User> => {
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({
        username: 'audit-student',
        name: 'Audit Student',
        first_name: null,
        last_name: null,
        email: 'audit-student@example.test',
        phone: '01099999999',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  };

  const makePaidOrder = async (
    teacher: User,
    student: User,
    orderNumber: string,
  ): Promise<Order> => {
    const orders = dataSource.getRepository(Order);
    return orders.save(
      orders.create({
        order_number: orderNumber,
        student_id: student.id,
        teacher_id: teacher.id,
        item_type: ItemType.LESSON,
        item_id: teacher.id, // any uuid; the audit query never dereferences it
        quantity: 1,
        original_amount_minor: 10_000,
        discount_amount_minor: 0,
        final_amount_minor: 10_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: 'easykash',
        status: OrderStatus.PAID,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Audit lesson',
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
  };

  const makeSettlement = async (
    teacher: User,
    suffix: string,
    initiatedBy: string,
  ): Promise<Settlement> => {
    const settlements = dataSource.getRepository(Settlement);
    return settlements.save(
      settlements.create({
        settlement_number: `ST-AUDIT-${suffix}`,
        idempotency_key: `audit-key-${suffix}`,
        idempotency_fingerprint: suffix.padEnd(64, '0'),
        teacher_id: teacher.id,
        gross_amount_minor: 7000,
        deductions_minor: 0,
        receivable_offset_minor: 0,
        payout_amount_minor: 7000,
        currency: 'EGP',
        fiscal_period: '2026-08',
        status: SettlementStatus.DRAFT,
        payment_method: 'bank_transfer',
        transfer_reference: null,
        execution_idempotency_key: null,
        execution_fingerprint: null,
        proof_file_key: null,
        notes: null,
        initiated_by: initiatedBy,
        approved_by: null,
        paid_by: null,
        paid_at: null,
      }),
    );
  };

  const audit = async (resourceType: string, resourceId: string, action: string): Promise<void> => {
    await dataSource.getRepository(PaymentAuditLog).insert({
      actor_id: null,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      details: {},
      ip_address: null,
    });
  };

  /** An admin holding every finance permission. */
  const financeAdmin = async () => {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    return admin;
  };

  it('returns only the requested teacher across every resource type', async () => {
    const admin = await financeAdmin();
    const [teacherA, teacherB, student] = await Promise.all([
      makeTeacher('1'),
      makeTeacher('2'),
      makeStudent(),
    ]);
    const orderA = await makePaidOrder(teacherA, student, 'AUDIT-A');
    const orderB = await makePaidOrder(teacherB, student, 'AUDIT-B');
    const settlementA = await makeSettlement(teacherA, 'a', admin.userId);
    const settlementB = await makeSettlement(teacherB, 'b', admin.userId);

    await audit('order', orderA.id, 'payment_finalized');
    await audit('order', orderB.id, 'payment_finalized');
    await audit('settlement', settlementA.id, 'settlement_created');
    await audit('settlement', settlementB.id, 'settlement_created');

    const response = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacherA.id })
      .expect(200);

    const rows = response.body.data as Array<{ resource_id: string }>;
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => row.resource_id).sort();
    expect(ids).toEqual([orderA.id, settlementA.id].sort());
    // Nothing belonging to the other teacher may appear.
    expect(ids).not.toContain(orderB.id);
    expect(ids).not.toContain(settlementB.id);
  });

  it('resolves refunds to a teacher through their order', async () => {
    const admin = await financeAdmin();
    const [teacher, other, student] = await Promise.all([
      makeTeacher('3'),
      makeTeacher('4'),
      makeStudent(),
    ]);
    const order = await makePaidOrder(teacher, student, 'AUDIT-REFUND');
    const refunds = dataSource.getRepository(Refund);
    const refund = await refunds.save(
      refunds.create({
        order_id: order.id,
        payment_id: null,
        channel: PaymentChannel.GATEWAY,
        amount_minor: 10_000,
        currency: 'EGP',
        status: RefundStatus.REQUESTED,
        reason_code: 'duplicate',
        reason: null,
        internal_note: null,
        external_method: null,
        external_reference: null,
        proof_file_key: null,
        requested_by: admin.userId,
        approved_by: null,
        completed_by: null,
        completed_at: null,
        metadata: null,
      }),
    );
    await audit('refund', refund.id, 'refund_requested');

    const owned = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id })
      .expect(200);
    expect(owned.body.data).toHaveLength(1);
    expect(owned.body.data[0].action).toBe('refund_requested');

    const foreign = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: other.id })
      .expect(200);
    expect(foreign.body.data).toHaveLength(0);
  });

  it('filters by resource type, action, and date without leaking scope', async () => {
    const admin = await financeAdmin();
    const [teacher, student] = await Promise.all([makeTeacher('5'), makeStudent()]);
    const order = await makePaidOrder(teacher, student, 'AUDIT-FILTER');
    const settlement = await makeSettlement(teacher, 'c', admin.userId);
    await audit('order', order.id, 'payment_finalized');
    await audit('settlement', settlement.id, 'settlement_created');

    const byType = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id, resource_type: 'settlement' })
      .expect(200);
    expect(byType.body.data).toHaveLength(1);
    expect(byType.body.data[0].resource_type).toBe('settlement');

    const byAction = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id, action: 'payment_finalized' })
      .expect(200);
    expect(byAction.body.data).toHaveLength(1);

    const future = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id, from: '2099-01-01T00:00:00.000Z' })
      .expect(200);
    expect(future.body.data).toHaveLength(0);
  });

  describe('GET /admin/finance/audit/actions (T080)', () => {
    /** A refund and a manual submission both owned by `order`'s teacher, through the order. */
    async function refundAndSubmission(
      order: Order,
      studentId: string,
      adminId: string,
    ): Promise<{ refundId: string; submissionId: string }> {
      const refunds = dataSource.getRepository(Refund);
      const refund = await refunds.save(
        refunds.create({
          order_id: order.id,
          payment_id: null,
          channel: PaymentChannel.GATEWAY,
          amount_minor: 10_000,
          currency: 'EGP',
          status: RefundStatus.REQUESTED,
          reason_code: 'duplicate',
          reason: null,
          internal_note: null,
          external_method: null,
          external_reference: null,
          proof_file_key: null,
          requested_by: adminId,
          approved_by: null,
          completed_by: null,
          completed_at: null,
          metadata: null,
        }),
      );
      const method: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO manual_payment_methods (name, type, recipient_name, destination_details, instructions, created_by, updated_by)
         VALUES ('Wallet', 'wallet', 'Recipient', '{}'::jsonb, 'pay', $1, $1) RETURNING id`,
        [adminId],
      );
      const submission: Array<{ id: string }> = await dataSource.query(
        `INSERT INTO manual_payment_submissions
           (order_id, student_id, manual_payment_method_id, claimed_amount_minor, currency, payer_name, status, submitted_at)
         VALUES ($1, $2, $3, 10000, 'EGP', 'Payer', 'submitted', NOW()) RETURNING id`,
        [order.id, studentId, method[0]!.id],
      );
      return { refundId: refund.id, submissionId: submission[0]!.id };
    }

    it('offers exactly the actions the teacher-scoped list shows, across all four resource types', async () => {
      const admin = await financeAdmin();
      const [teacherA, teacherB, student] = await Promise.all([
        makeTeacher('a1'),
        makeTeacher('b1'),
        makeStudent(),
      ]);
      const orderA = await makePaidOrder(teacherA, student, 'ACT-A');
      const orderB = await makePaidOrder(teacherB, student, 'ACT-B');
      const settlementA = await makeSettlement(teacherA, 'act-a', admin.userId);
      const settlementB = await makeSettlement(teacherB, 'act-b', admin.userId);
      const a = await refundAndSubmission(orderA, student.id, admin.userId);
      const b = await refundAndSubmission(orderB, student.id, admin.userId);

      await audit('order', orderA.id, 'a_order_action');
      await audit('order', orderA.id, 'a_order_action'); // duplicates collapse
      await audit('settlement', settlementA.id, 'a_settlement_action');
      await audit('refund', a.refundId, 'a_refund_action');
      await audit('manual_payment_submission', a.submissionId, 'a_manual_action');
      await audit('order', orderB.id, 'b_order_action');
      await audit('settlement', settlementB.id, 'b_settlement_action');
      await audit('refund', b.refundId, 'b_refund_action');
      await audit('manual_payment_submission', b.submissionId, 'b_manual_action');
      // A resource id that resolves to nobody, and a mismatched type for A's order id: both belong to no teacher.
      await audit('order', '00000000-0000-4000-8000-000000000000', 'orphan_action');
      await audit('refund', orderA.id, 'wrong_type_action');

      const forA = await admin.agent
        .get(`${API_PREFIX}/admin/finance/audit/actions`)
        .query({ teacher_id: teacherA.id })
        .expect(200);
      expect(forA.body.data).toEqual([
        'a_manual_action',
        'a_order_action',
        'a_refund_action',
        'a_settlement_action',
      ]);

      const forB = await admin.agent
        .get(`${API_PREFIX}/admin/finance/audit/actions`)
        .query({ teacher_id: teacherB.id })
        .expect(200);
      expect(forB.body.data).toEqual([
        'b_manual_action',
        'b_order_action',
        'b_refund_action',
        'b_settlement_action',
      ]);

      // The dropdown equals the distinct actions of the list for the same teacher.
      const list = await admin.agent
        .get(`${API_PREFIX}/admin/finance/audit`)
        .query({ teacher_id: teacherA.id, limit: 100 })
        .expect(200);
      const listed = [
        ...new Set((list.body.data as Array<{ action: string }>).map((row) => row.action)),
      ].sort();
      expect(forA.body.data).toEqual(listed);
    });

    it('keeps the guards: 400 without a teacher id, 403 without permission or as a teacher, 401 anonymous', async () => {
      const teacher = await makeTeacher('a2');
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await dataSource
        .getRepository(User)
        .update({ id: admin.userId }, { finance_permissions: [] });
      await admin.agent
        .get(`${API_PREFIX}/admin/finance/audit/actions`)
        .query({ teacher_id: teacher.id })
        .expect(403);

      const finance = await financeAdmin();
      await finance.agent.get(`${API_PREFIX}/admin/finance/audit/actions`).expect(400);

      const impostor = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
      await impostor.agent
        .get(`${API_PREFIX}/admin/finance/audit/actions`)
        .query({ teacher_id: teacher.id })
        .expect(403);

      await request(server)
        .get(`${API_PREFIX}/admin/finance/audit/actions`)
        .query({ teacher_id: teacher.id })
        .expect(401);
    });
  });

  it('rejects an unknown resource type instead of widening the scope', async () => {
    const teacher = await makeTeacher('6');
    const admin = await financeAdmin();

    await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id, resource_type: 'everything' })
      .expect(400);
  });

  it('requires a teacher id', async () => {
    const admin = await financeAdmin();

    await admin.agent.get(`${API_PREFIX}/admin/finance/audit`).expect(400);
  });

  it('denies an admin without the settlements.view permission', async () => {
    const teacher = await makeTeacher('7');
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource.getRepository(User).update({ id: admin.userId }, { finance_permissions: [] });

    await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id })
      .expect(403);
  });

  it('denies teachers, who must never read the administrative trail', async () => {
    const teacher = await makeTeacher('8');
    const impostor = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });

    await impostor.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id })
      .expect(403);
  });

  it('denies unauthenticated callers', async () => {
    const teacher = await makeTeacher('9');

    await request(server)
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id })
      .expect(401);
  });

  it('paginates newest first', async () => {
    const [teacher, student] = await Promise.all([makeTeacher('10'), makeStudent()]);
    const order = await makePaidOrder(teacher, student, 'AUDIT-PAGE');
    await audit('order', order.id, 'first_action');
    await audit('order', order.id, 'second_action');

    const admin = await financeAdmin();
    const response = await admin.agent
      .get(`${API_PREFIX}/admin/finance/audit`)
      .query({ teacher_id: teacher.id, page: 1, limit: 1 })
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].action).toBe('second_action');
    expect(response.body.meta).toMatchObject({
      page: 1,
      limit: 1,
      total: 2,
      totalPages: 2,
      hasNextPage: true,
      hasPrevPage: false,
    });
  });

  /**
   * T041 (`gates/W1-C8.md`, approved): the reconciliation-warnings snapshot is cached (10 min TTL, or
   * one generation bump reaching `finance_reconciliation`), so `detected_at` is the compute time, not
   * the request time, and a second visit within the same snapshot does not re-run the sweep.
   */
  describe('GET /admin/finance/reports/reconciliation-warnings (T041)', () => {
    it('requires reconciliation.review', async () => {
      const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
      await dataSource
        .getRepository(User)
        .update({ id: admin.userId }, { finance_permissions: [] });

      await admin.agent
        .get(`${API_PREFIX}/admin/finance/reports/reconciliation-warnings`)
        .expect(403);
    });

    it('detected_at is the compute time (not the request time) and a repeat visit within the snapshot returns the identical detected_at (no re-sweep)', async () => {
      const [teacher, student] = await Promise.all([makeTeacher('recon-1'), makeStudent()]);
      // A paid order with no entitlement row is exactly what `paid_orders_without_entitlement` flags.
      await makePaidOrder(teacher, student, 'AUDIT-RECON-1');

      const admin = await financeAdmin();
      const before = new Date();
      const first = await admin.agent
        .get(`${API_PREFIX}/admin/finance/reports/reconciliation-warnings`)
        .expect(200);
      const after = new Date();

      const warnings = first.body.data as Array<{
        type: string;
        affected_count: number;
        detected_at: string;
      }>;
      const paidWithoutEntitlement = warnings.find(
        (w) => w.type === 'paid_orders_without_entitlement',
      );
      expect(paidWithoutEntitlement).toBeDefined();
      expect(paidWithoutEntitlement!.affected_count).toBeGreaterThanOrEqual(1);
      const detectedAt = new Date(paidWithoutEntitlement!.detected_at).getTime();
      expect(detectedAt).toBeGreaterThanOrEqual(before.getTime());
      expect(detectedAt).toBeLessThanOrEqual(after.getTime());

      // A second admin visit inside the same TTL/generation window is a cache hit: `detected_at` does
      // not move even though real time has advanced, proving the sweep was not re-run.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await admin.agent
        .get(`${API_PREFIX}/admin/finance/reports/reconciliation-warnings`)
        .expect(200);
      const secondWarnings = second.body.data as Array<{ type: string; detected_at: string }>;
      expect(
        secondWarnings.find((w) => w.type === 'paid_orders_without_entitlement')?.detected_at,
      ).toBe(paidWithoutEntitlement!.detected_at);
    });

    it('counts are never silently capped below the truth: an exact count under 101 is reported as-is', async () => {
      const [teacher, student] = await Promise.all([makeTeacher('recon-2'), makeStudent()]);
      await Promise.all([
        makePaidOrder(teacher, student, 'AUDIT-RECON-2A'),
        makePaidOrder(teacher, student, 'AUDIT-RECON-2B'),
      ]);

      const admin = await financeAdmin();
      const res = await admin.agent
        .get(`${API_PREFIX}/admin/finance/reports/reconciliation-warnings`)
        .expect(200);

      const warnings = res.body.data as Array<{ type: string; affected_count: number }>;
      const found = warnings.find((w) => w.type === 'paid_orders_without_entitlement');
      expect(found?.affected_count).toBe(2);
    });
  });

  /** `GET admin/finance/reconciliation` (the live endpoint) is unaffected by the T041 snapshot cache. */
  describe('GET /admin/finance/reconciliation stays live', () => {
    it('reflects a newly created warning immediately, with no cache in front of it', async () => {
      const admin = await financeAdmin();
      const warm = await admin.agent.get(`${API_PREFIX}/admin/finance/reconciliation`).expect(200);
      const before = (warm.body.data.paid_orders_without_entitlement as unknown[]).length;

      const [teacher, student] = await Promise.all([makeTeacher('recon-live'), makeStudent()]);
      await makePaidOrder(teacher, student, 'AUDIT-RECON-LIVE');

      const fresh = await admin.agent.get(`${API_PREFIX}/admin/finance/reconciliation`).expect(200);
      expect((fresh.body.data.paid_orders_without_entitlement as unknown[]).length).toBe(
        before + 1,
      );
    });
  });
});
