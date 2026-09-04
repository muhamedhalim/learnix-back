import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { MarketplaceCategory } from '../../src/marketplace/catalog/entities';
import { MarketplaceEnrollment, MarketplaceOrder } from '../../src/marketplace/commerce/entities';
import { InstructorEarningStatus, LessonContentType, PayoutRequestStatus } from '../../src/marketplace/common/enums';
import { ClearanceSweepService } from '../../src/marketplace/jobs/clearance.job';
import { InstructorEarning } from '../../src/marketplace/earnings/entities/instructor-earning.entity';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import {
  CollectionParty,
  ItemType,
  Order,
  OrderStatus,
  PaymentChannel,
  Settlement,
  SettlementStatus,
} from '../../src/payments/entities';
import { FinancialLedgerEntry } from '../../src/payments/entities/financial-ledger-entry.entity';
import { LedgerDirection, LedgerEntryStatus, LedgerEntryType } from '../../src/payments/entities/ledger.enums';
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
import { buildRegisterPayload } from './factories/user.factory';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { getUserIdByEmail, setUserStatus } from './helpers/database';

/**
 * T201 (US11, release gate). The academic settlement machinery
 * (`SettlementsService`, `financial_ledger_entries`, `teacher_settlements`)
 * predates the marketplace and was never touched by it (per T228's schema
 * assertion: no marketplace table holds a foreign key into any of those).
 * This suite makes that guarantee observable at the API surface rather than
 * just the schema: it runs the identical academic earn → settle → pay
 * journey twice, from identical inputs, once with the database otherwise
 * empty and once with a full, real marketplace course purchase / earning /
 * payout cycle already sitting alongside it — and asserts the two runs
 * produce byte-identical financial results (FR-002, SC-001).
 */
describe('academic non-disruption — the academic settlement journey is unaffected by marketplace activity (Phase 13, T201)', () => {
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

  async function makeTeacher(suffix: string): Promise<User> {
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({
        username: `nondisrupt-teacher-${suffix}`,
        name: `Non-Disruption Teacher ${suffix}`,
        first_name: null,
        last_name: null,
        email: `nondisrupt-teacher-${suffix}@example.test`,
        phone: `0111${suffix.padStart(7, '0')}`,
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function makeStudent(suffix: string): Promise<User> {
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({
        username: `nondisrupt-student-${suffix}`,
        name: `Non-Disruption Student ${suffix}`,
        first_name: null,
        last_name: null,
        email: `nondisrupt-student-${suffix}@example.test`,
        phone: `0112${suffix.padStart(7, '0')}`,
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function financeAdmin() {
    const admin = await createAuthenticatedUser(app, dataSource, { role: 'admin' });
    await dataSource.getRepository(User).update({ id: admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] });
    return admin;
  }

  /**
   * Drives one complete, deterministic academic earn → settle → pay journey
   * for a fresh teacher/student pair and returns the figures that matter,
   * stripped of anything that is inherently unique per run (ids, the
   * settlement number, timestamps).
   */
  async function runAcademicJourney(suffix: string) {
    const teacher = await makeTeacher(suffix);
    const student = await makeStudent(suffix);
    const admin = await financeAdmin();
    // `SettlementsService.approve()`/`markPaid()` enforce three-way
    // maker-checker separation (`initiated_by`/`approved_by === adminId` is
    // refused at each step) — three distinct admins create, approve and
    // disburse, exactly like a real dual-control finance workflow.
    const approvingAdmin = await financeAdmin();
    const payingAdmin = await financeAdmin();

    const orders = dataSource.getRepository(Order);
    const order = await orders.save(
      orders.create({
        order_number: `NONDISRUPT-${suffix}`,
        student_id: student.id,
        teacher_id: teacher.id,
        item_type: ItemType.LESSON,
        item_id: teacher.id,
        quantity: 1,
        original_amount_minor: 100_000,
        discount_amount_minor: 0,
        final_amount_minor: 100_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: 'paymob',
        status: OrderStatus.PAID,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Non-disruption lesson',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 30_000,
        teacher_earning_minor: 70_000,
        discount_snapshot: null,
        metadata: null,
        expires_at: null,
        paid_at: new Date('2026-03-10T12:00:00.000Z'),
        cancelled_at: null,
      }),
    );

    await dataSource.getRepository(FinancialLedgerEntry).save(
      dataSource.getRepository(FinancialLedgerEntry).create({
        account: 'teacher_payable_available',
        order_id: order.id,
        payment_id: null,
        teacher_id: teacher.id,
        entry_type: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
        amount_minor: 70_000,
        currency: 'EGP',
        direction: LedgerDirection.CREDIT,
        status: LedgerEntryStatus.POSTED,
        available_at: new Date('2026-03-10T12:00:00.000Z'),
        source_channel: PaymentChannel.GATEWAY,
        collection_party: CollectionParty.PLATFORM,
        reference: `nondisrupt-earning-${suffix}`,
        settlement_id: null,
        metadata: null,
      }),
    );

    const createRes = await admin.agent
      .post(`${API_PREFIX}/admin/finance/settlements`)
      .send({ teacher_id: teacher.id, idempotency_key: `nondisrupt-settle-${suffix}`, currency: 'EGP', payment_method: 'bank_transfer' })
      .expect(201);
    const settlementId = createRes.body.data.id as string;

    await approvingAdmin.agent.post(`${API_PREFIX}/admin/finance/settlements/${settlementId}/approve`).send({}).expect(201);
    const paidRes = await payingAdmin.agent
      .post(`${API_PREFIX}/admin/finance/settlements/${settlementId}/pay`)
      // Deliberately the SAME literal reference for every run — this suite
      // compares the two runs' results for byte-identical equality, and a
      // `suffix`-dependent value here would make that comparison spuriously
      // fail on a field that was never claimed to be marketplace-sensitive.
      .send({ transfer_reference: 'TXN-NONDISRUPT' })
      .expect(201);

    const balances = await admin.agent
      .get(`${API_PREFIX}/admin/finance/settlements/teacher-balances`)
      .query({ teacher_id: teacher.id })
      .expect(200);

    const finalSettlement = await dataSource.getRepository(Settlement).findOneByOrFail({ id: settlementId });
    const finalOrder = await dataSource.getRepository(Order).findOneByOrFail({ id: order.id });

    return {
      order: {
        final_amount_minor: finalOrder.final_amount_minor,
        platform_commission_minor: finalOrder.platform_commission_minor,
        teacher_earning_minor: finalOrder.teacher_earning_minor,
        status: finalOrder.status,
      },
      settlement: {
        gross_amount_minor: finalSettlement.gross_amount_minor,
        payout_amount_minor: finalSettlement.payout_amount_minor,
        currency: finalSettlement.currency,
        status: finalSettlement.status,
        transfer_reference: finalSettlement.transfer_reference,
      },
      payResponseStatus: paidRes.body.data.status as string,
      // `GET .../teacher-balances` returns `{ data: [...one row per currency], meta }`,
      // not the flat legacy shape — pull out the EGP row explicitly, and
      // only the financial figures: `teacher_id`/`teacher_email`/`teacher_name`
      // are this run's own randomly-suffixed identity, never claimed to be
      // marketplace-sensitive, so comparing them would spuriously fail.
      teacherBalances: (() => {
        const row = (balances.body.data as Array<Record<string, unknown>>).find((r) => r['currency'] === 'EGP');
        return {
          currency: row?.['currency'],
          available_minor: row?.['available_minor'],
          paid_minor: row?.['paid_minor'],
          pending_minor: row?.['pending_minor'],
          reserved_minor: row?.['reserved_minor'],
        };
      })(),
    };
  }

  /** A full, real marketplace course purchase → cleared earning → paid payout, for entirely unrelated users. */
  async function seedMarketplaceActivity(): Promise<void> {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await dataSource.getRepository(MarketplaceInstructor).save(buildInstructorFixture({ user_id: instructorUser.userId }));
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
        title: `Non-Disruption Noise Course ${Date.now()}`,
        summary: 'Marketplace noise for the isolation proof',
        description: 'A full description of the course content.',
        category_id: category.id,
        level: 'beginner',
        language: 'en',
        price_minor: 200000,
        currency: 'EGP',
        cover_image_key: 'covers/noise-101.jpg',
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
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`).send({}).expect(201);
    await marketplaceAdmin.agent.post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`).send({}).expect(201);
    await instructorUser.agent.post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`).send({}).expect(201);

    const orderRes = await learner.agent
      .post(`${API_PREFIX}/marketplace/checkout/orders`)
      .set('Idempotency-Key', `noise-order-${Date.now()}`)
      .send({ courseId })
      .expect(201);
    let order = await dataSource.getRepository(MarketplaceOrder).findOneByOrFail({ id: orderRes.body.id as string });

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
        provider_reference: `provider-noise-${order.id}`,
        paymob_order_id: `provider-noise-${order.id}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: `marketplace-checkout:${order.id}`,
      }),
    );
    await dataSource.getRepository(MarketplaceOrder).update(order.id, { payment_id: payment.id });

    const event: ProviderWebhookEvent = {
      provider: 'paymob',
      providerEventId: `noise-settle-${order.id}`,
      merchantReference: payment.id,
      providerOrderReference: payment.paymob_order_id!,
      transactionId: `noise-txn-${order.id}`,
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

    const accountRes = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payout-accounts`)
      .send({
        account_holder_name: 'Noise Instructor',
        bank_name: 'Test Bank',
        account_identifier: 'EG9876543210987654321098765432',
        currency: 'EGP',
        country: 'EG',
      })
      .expect(201);

    const requestRes = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/payouts`)
      .set('Idempotency-Key', `noise-payout-${Date.now()}`)
      .send({ payout_account_id: accountRes.body.id, amount_minor: cleared.net_amount_minor, currency: 'EGP' })
      .expect(201);
    const requestId = requestRes.body.id as string;
    await marketplaceAdmin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/approve`).send({}).expect(201);
    await marketplaceAdmin.agent.post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/processing`).send({}).expect(201);
    const paidPayout = await marketplaceAdmin.agent
      .post(`${API_PREFIX}/marketplace/admin/payouts/${requestId}/paid`)
      .send({ payout_reference: 'TXN-NOISE-1' })
      .expect(201);
    expect(paidPayout.body.status).toBe(PayoutRequestStatus.PAID);
  }

  it('produces byte-identical academic figures whether run against an empty database or one full of real marketplace activity', async () => {
    const withoutMarketplace = await runAcademicJourney('control');

    await resetDatabase(dataSource);
    await seedMarketplaceActivity();
    const withMarketplace = await runAcademicJourney('exposed');

    expect(withMarketplace).toEqual(withoutMarketplace);
    // Sanity: the comparison above is non-trivial — these are real, non-zero figures.
    expect(withMarketplace.order.teacher_earning_minor).toBe(70_000);
    expect(withMarketplace.settlement.payout_amount_minor).toBe(70_000);
    expect(withMarketplace.settlement.status).toBe(SettlementStatus.PAID);
  }, 60_000);

  it('a plain academic registration → login → catalogue browsing journey completes normally with marketplace activity present', async () => {
    await seedMarketplaceActivity();

    const server = app.getHttpServer() as Server;
    const credentials = buildRegisterPayload();
    await request(server).post(`${API_PREFIX}/auth/register`).send(credentials).expect(202);

    const userId = await getUserIdByEmail(dataSource, credentials.email);
    await setUserStatus(dataSource, userId, 'approved');

    const login = await request(server)
      .post(`${API_PREFIX}/auth/login`)
      .send({ email: credentials.email, password: credentials.password })
      .expect(200);
    expect(login.body).toBeDefined();

    const packages = await request(server).get(`${API_PREFIX}/packages`);
    expect(packages.status).toBeLessThan(500);
  }, 60_000);
});
