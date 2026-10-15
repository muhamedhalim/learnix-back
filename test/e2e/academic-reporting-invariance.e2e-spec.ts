import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { InstructorEarningStatus, LessonContentType } from '../../src/marketplace/common/enums';
import { ClearanceSweepService } from '../../src/marketplace/jobs/clearance.job';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import {
  CollectionParty,
  ItemType,
  Order,
  OrderStatus,
  PaymentChannel,
} from '../../src/payments/entities';
import { FinancialLedgerEntry } from '../../src/payments/entities/financial-ledger-entry.entity';
import {
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
} from '../../src/payments/entities/ledger.enums';
import { Payment } from '../../src/payments/entities/payment.entity';
import { PaymentMethod } from '../../src/payments/entities/payment-method.enum';
import { PaymentStatus } from '../../src/payments/entities/payment-status.enum';
import type { ProviderWebhookEvent } from '../../src/payments/providers/payment-gateway.interface';
import { GatewayWebhookService } from '../../src/payments/services/gateway-webhook.service';
import { PaymentOperationsService } from '../../src/payments/services/payment-operations.service';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { buildInstructorFixture } from './factories/marketplace.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';

/**
 * T202 (US11, release gate), deps: T201. `PaymentOperationsService.financialReport()`
 * and `SettlementsService.teacherBalances()` — the two admin-facing academic
 * money reports — are built entirely from `orders`, `financial_ledger_entries`
 * and `teacher_settlements` (confirmed by reading every CTE in
 * `financialReport()`: not one references a `marketplace_` table). This
 * suite turns that source-reading into a durable, runtime assertion: the
 * exact same report query, over the exact same academic data, returns
 * byte-identical results whether or not real marketplace transactions exist
 * in the same database (SC-002) — for a bounded period, for all time, and
 * for a dual-capability person whose own marketplace earnings sit right
 * next to their academic figures.
 */
describe('academic reporting invariance — report figures never move when marketplace transactions exist (Phase 13, T202)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let webhooks: GatewayWebhookService;
  let operations: PaymentOperationsService;
  let clearanceSweep: ClearanceSweepService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    webhooks = app.get(GatewayWebhookService);
    operations = app.get(PaymentOperationsService);
    clearanceSweep = app.get(ClearanceSweepService);
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function financeAdmin() {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource
      .getRepository(User)
      .update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    return admin;
  }

  async function seedAcademicOrder(
    teacherId: string,
    studentId: string,
    suffix: string,
    paidAt: Date,
  ) {
    const orders = dataSource.getRepository(Order);
    const order = await orders.save(
      orders.create({
        order_number: `REPINV-${suffix}`,
        student_id: studentId,
        teacher_id: teacherId,
        item_type: ItemType.LESSON,
        item_id: teacherId,
        quantity: 1,
        original_amount_minor: 120_000,
        discount_amount_minor: 0,
        final_amount_minor: 120_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: 'paymob',
        status: OrderStatus.PAID,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Reporting-invariance lesson',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 36_000,
        teacher_earning_minor: 84_000,
        discount_snapshot: null,
        metadata: null,
        expires_at: null,
        paid_at: paidAt,
        cancelled_at: null,
      }),
    );
    await dataSource.getRepository(FinancialLedgerEntry).save(
      dataSource.getRepository(FinancialLedgerEntry).create({
        account: 'teacher_payable_available',
        order_id: order.id,
        payment_id: null,
        teacher_id: teacherId,
        entry_type: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
        amount_minor: 84_000,
        currency: 'EGP',
        direction: LedgerDirection.CREDIT,
        status: LedgerEntryStatus.POSTED,
        available_at: paidAt,
        source_channel: PaymentChannel.GATEWAY,
        collection_party: CollectionParty.PLATFORM,
        reference: `repinv-earning-${suffix}`,
        settlement_id: null,
        metadata: null,
      }),
    );
    return order;
  }

  async function financialReport(
    admin: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    teacherId: string,
    range?: { from: string; to: string },
  ) {
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/finance/reports`)
      .query({ teacher_id: teacherId, currency: 'EGP', ...(range ?? {}) })
      .expect(200);
    // `generated_at` is "as of when this call ran", not a financial figure —
    // it is expected to differ between the before/after calls this suite
    // makes a few milliseconds apart, and asserting on it would make every
    // invariance check flaky rather than meaningful. Every other field is
    // still compared in full.
    const data = res.body.data as Record<string, unknown>;
    const { generated_at: _generatedAt, ...rest } = data;
    return rest;
  }

  async function teacherBalances(
    admin: Awaited<ReturnType<typeof createAuthenticatedUser>>,
    teacherId: string,
  ) {
    const res = await admin.agent
      .get(`${API_PREFIX}/admin/finance/settlements/teacher-balances`)
      .query({ teacher_id: teacherId })
      .expect(200);
    return res.body as unknown;
  }

  /** A full, real marketplace course purchase → cleared earning, for a given (possibly dual-capability) user. */
  async function seedMarketplaceEarningFor(
    instructorUser: Awaited<ReturnType<typeof createAuthenticatedUser>>,
  ): Promise<void> {
    await dataSource
      .getRepository(MarketplaceInstructor)
      .save(buildInstructorFixture({ user_id: instructorUser.userId }));
    const marketplaceAdmin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource
      .getRepository(User)
      .update({ id: marketplaceAdmin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    const learner = await createAuthenticatedUser(app, dataSource);
    const category = await dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      display_order: 1,
    });

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send({
        title: `Reporting Invariance Course ${Date.now()}`,
        summary: 'Marketplace noise for the reporting-invariance proof',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 200000,
        currency: 'EGP',
        cover_image_key: 'covers/repinv-101.jpg',
        learning_outcomes: ['n/a'],
      })
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          content_html: `<p>Content ${i + 1}</p>`,
          duration_seconds: 120,
          is_free_preview: i === 0,
          is_required_for_completion: true,
        })
        .expect(201);
    }
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await marketplaceAdmin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);

    const orderRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `repinv-order-${Date.now()}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource
      .getRepository(MarketplaceOrder)
      .findOneByOrFail({ id: orderRes.body.id as string });

    const payments = dataSource.getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        user_id: learner.userId,
        item_type: ItemType.MARKETPLACE_COURSE,
        item_id: order.id,
        amount: order.net_amount_minor / 100,
        final_amount: order.net_amount_minor / 100,
        amount_minor: order.net_amount_minor,
        currency: order.currency,
        channel: PaymentChannel.GATEWAY,
        provider: 'paymob',
        provider_reference: `provider-repinv-${order.id}`,
        paymob_order_id: `provider-repinv-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'paymob',
      providerEventId: `repinv-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.paymob_order_id!,
      transactionId: `repinv-txn-${order.id}`,
      amountMinor: payment.amount_minor!,
      currency: payment.currency,
      occurredAt: new Date(),
      outcome: 'succeeded',
      isLive: false,
      payload: {},
    };
    await webhooks.process(event);
    await operations.publishOutbox();

    order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: order.id });
    await dataSource.getRepository(MarketplaceEnrollment).findOneByOrFail({ order_id: order.id });

    const earnings = dataSource.getRepository(InstructorEarning);
    const earning = await earnings.findOneByOrFail({ order_id: order.id });
    await earnings.update(earning.id, { available_at: new Date(Date.now() - 1000) });
    await clearanceSweep.runSweep();
    const cleared = await earnings.findOneByOrFail({ id: earning.id });
    expect(cleared.status).toBe(InstructorEarningStatus.AVAILABLE_BALANCE);
  }

  it('a bounded-period report is byte-identical before and after unrelated marketplace transactions exist', async () => {
    const users = dataSource.getRepository(User);
    const teacher = await users.save(
      users.create({
        username: 'repinv-teacher-1',
        name: 'Reporting Invariance Teacher',
        first_name: null,
        last_name: null,
        email: 'repinv-teacher-1@example.test',
        phone: '01130000001',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const student = await users.save(
      users.create({
        username: 'repinv-student-1',
        name: 'Reporting Invariance Student',
        first_name: null,
        last_name: null,
        email: 'repinv-student-1@example.test',
        phone: '01130000002',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    await seedAcademicOrder(
      teacher.id,
      student.id,
      'bounded',
      new Date('2026-02-15T10:00:00.000Z'),
    );

    const admin = await financeAdmin();
    const range = { from: '2026-02-01', to: '2026-03-01' };
    const reportBefore = await financialReport(admin, teacher.id, range);
    const balancesBefore = await teacherBalances(admin, teacher.id);

    const unrelatedInstructor = await createAuthenticatedUser(app, dataSource);
    await seedMarketplaceEarningFor(unrelatedInstructor);

    const reportAfter = await financialReport(admin, teacher.id, range);
    const balancesAfter = await teacherBalances(admin, teacher.id);

    expect(reportAfter).toEqual(reportBefore);
    expect(balancesAfter).toEqual(balancesBefore);
    // Sanity: this compared real, non-zero figures, not two empty reports.
    const egpBalanceAfter = (
      balancesAfter as { data: Array<{ currency: string; available_minor: string }> }
    ).data.find((row) => row.currency === 'EGP');
    expect(Number(egpBalanceAfter?.available_minor)).toBe(84_000);
  }, 60_000);

  it('a wide multi-decade period report is also byte-identical, proving invariance holds for any period, not just a coincidental one', async () => {
    const users = dataSource.getRepository(User);
    const teacher = await users.save(
      users.create({
        username: 'repinv-teacher-2',
        name: 'Reporting Invariance Teacher 2',
        first_name: null,
        last_name: null,
        email: 'repinv-teacher-2@example.test',
        phone: '01130000003',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const student = await users.save(
      users.create({
        username: 'repinv-student-2',
        name: 'Reporting Invariance Student 2',
        first_name: null,
        last_name: null,
        email: 'repinv-student-2@example.test',
        phone: '01130000004',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    await seedAcademicOrder(
      teacher.id,
      student.id,
      'wide-range',
      new Date('2020-01-01T00:00:00.000Z'),
    );

    const admin = await financeAdmin();
    const wideRange = { from: '2000-01-01', to: '2099-01-01' };
    const reportBefore = await financialReport(admin, teacher.id, wideRange);
    const balancesBefore = await teacherBalances(admin, teacher.id);

    const unrelatedInstructor = await createAuthenticatedUser(app, dataSource);
    await seedMarketplaceEarningFor(unrelatedInstructor);

    const reportAfter = await financialReport(admin, teacher.id, wideRange);
    const balancesAfter = await teacherBalances(admin, teacher.id);
    expect(reportAfter).toEqual(reportBefore);
    expect(balancesAfter).toEqual(balancesBefore);
    const egpBalanceAfter = (
      balancesAfter as { data: Array<{ currency: string; available_minor: string }> }
    ).data.find((row) => row.currency === 'EGP');
    expect(Number(egpBalanceAfter?.available_minor)).toBe(84_000);
  }, 60_000);

  it("a dual-capability person's own academic figures are unaffected by their own marketplace earnings", async () => {
    const dualUser = await createAuthenticatedUser(app, dataSource, { role: 'teacher' });
    const student = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        username: 'repinv-dual-student',
        name: 'Reporting Invariance Dual Student',
        first_name: null,
        last_name: null,
        email: 'repinv-dual-student@example.test',
        phone: '01130000005',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    await seedAcademicOrder(
      dualUser.userId,
      student.id,
      'dual',
      new Date('2026-04-01T00:00:00.000Z'),
    );

    const admin = await financeAdmin();
    const dualRange = { from: '2000-01-01', to: '2099-01-01' };
    const reportBefore = await financialReport(admin, dualUser.userId, dualRange);
    const balancesBefore = await teacherBalances(admin, dualUser.userId);

    // The SAME person now also earns real marketplace money as an instructor.
    await seedMarketplaceEarningFor(dualUser);

    const reportAfter = await financialReport(admin, dualUser.userId, dualRange);
    const balancesAfter = await teacherBalances(admin, dualUser.userId);

    expect(reportAfter).toEqual(reportBefore);
    expect(balancesAfter).toEqual(balancesBefore);
    const egpBalanceAfter = (
      balancesAfter as { data: Array<{ currency: string; available_minor: string }> }
    ).data.find((row) => row.currency === 'EGP');
    expect(Number(egpBalanceAfter?.available_minor)).toBe(84_000);
  }, 60_000);

  it('T054: a widget subset deep-equals the same widgets of the full report; unselected ones are empty', async () => {
    const users = dataSource.getRepository(User);
    const make = (username: string, role: UserRole, phone: string) =>
      users.save(
        users.create({
          username,
          name: username,
          first_name: null,
          last_name: null,
          email: `${username}@example.test`,
          phone,
          role,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
        }),
      );
    const teacher = await make('widgets-teacher-1', UserRole.TEACHER, '01130000011');
    const student = await make('widgets-student-1', UserRole.STUDENT, '01130000012');
    await seedAcademicOrder(teacher.id, student.id, 'subset', new Date('2026-02-15T10:00:00.000Z'));

    const admin = await financeAdmin();
    // No explicit range: ledger rows are dated at insert time, inside the default window.
    const full = await financialReport(admin, teacher.id);
    // Every widget must run: a widget whose SQL fails is swallowed into `widget_errors` and renders empty
    // (the teacher/currency filter used to break six of them with bind-parameter errors).
    expect(full['widget_errors']).toEqual([]);
    const subsetRes = await admin.agent
      .get(`${API_PREFIX}/admin/finance/reports`)
      .query({
        teacher_id: teacher.id,
        currency: 'EGP',
        widgets: 'summary,teacher_receivables',
      })
      .expect(200);
    const {
      generated_at: _g,
      filters: _f,
      ...subset
    } = subsetRes.body.data as Record<string, unknown>;
    const { filters: _ff, ...fullRest } = full;

    // Selected widgets carry real data for this fixture and match the full report exactly.
    expect((fullRest['summary'] as unknown[]).length).toBeGreaterThan(0);
    expect((fullRest['teachers'] as { data: unknown[] }).data.length).toBeGreaterThan(0);
    expect(subset['summary']).toEqual(fullRest['summary']);
    expect(subset['teachers']).toEqual(fullRest['teachers']);
    // Unselected widgets are empty, not computed, and not reported as errors.
    for (const key of [
      'trends',
      'product_breakdown',
      'top_products',
      'settlement_analytics',
      'ledger_movements',
      'settlement_history',
    ]) {
      expect(subset[key]).toEqual([]);
    }
    expect(subset['widget_errors']).toEqual([]);

    await admin.agent
      .get(`${API_PREFIX}/admin/finance/reports`)
      .query({ widgets: 'nope' })
      .expect(400);
  }, 60_000);
});
