import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import request from 'supertest';

import {
  CollectionParty,
  FinancialLedgerEntry,
  ItemType,
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
  Order,
  OrderStatus,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
  Settlement,
  SettlementStatus,
} from '../../src/payments/entities';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

describe('Call Center Phase 6 finance facade (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  async function financeFixture() {
    const student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
    const teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'teacher' });
    const admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    const support = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'call_center' });
    const orders = ctx.dataSource.getRepository(Order);
    const order = await orders.save(
      orders.create({
        order_number: `CC-FIN-${Date.now()}`,
        student_id: student.userId,
        teacher_id: teacher.userId,
        item_type: ItemType.LESSON,
        item_id: randomUUID(),
        quantity: 1,
        original_amount_minor: 10_000,
        discount_amount_minor: 0,
        final_amount_minor: 10_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: 'card',
        status: OrderStatus.PAID,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Call Center finance test purchase',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 2_000,
        platform_commission_minor: 2_000,
        teacher_earning_minor: 8_000,
        discount_snapshot: null,
        metadata: { provider_payload: 'must-not-leak' },
        expires_at: null,
        paid_at: new Date(),
        cancelled_at: null,
      }),
    );
    const payments = ctx.dataSource.getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        order_id: order.id,
        user_id: student.userId,
        item_type: ItemType.LESSON,
        item_id: order.item_id,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: 'test-gateway',
        provider_reference: 'secret-provider-reference',
        paymob_order_id: 'secret-gateway-order',
        paymob_transaction_id: 'secret-gateway-transaction',
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.CARD,
        idempotency_key: randomUUID(),
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
    await orders.update(order.id, { payment_id: payment.id });
    const settlements = ctx.dataSource.getRepository(Settlement);
    const settlement = await settlements.save(
      settlements.create({
        settlement_number: `CC-SET-${Date.now()}`,
        idempotency_key: randomUUID(),
        idempotency_fingerprint: 'a'.repeat(64),
        teacher_id: teacher.userId,
        gross_amount_minor: 10_000,
        deductions_minor: 2_000,
        receivable_offset_minor: 0,
        payout_amount_minor: 8_000,
        currency: 'EGP',
        fiscal_period: '2026-08',
        status: SettlementStatus.PAID,
        payment_method: 'bank_transfer',
        transfer_reference: 'SAFE-TRANSFER-REFERENCE',
        execution_idempotency_key: 'must-not-leak',
        execution_fingerprint: 'b'.repeat(64),
        proof_file_key: 'private-proof-key',
        notes: 'private note',
        initiated_by: admin.userId,
        approved_by: admin.userId,
        paid_by: admin.userId,
        paid_at: new Date(),
      }),
    );
    const ledger = ctx.dataSource.getRepository(FinancialLedgerEntry);
    await ledger.save([
      ledger.create({
        account: 'teacher_payable_available',
        order_id: order.id,
        payment_id: payment.id,
        teacher_id: teacher.userId,
        entry_type: LedgerEntryType.TEACHER_EARNING_AVAILABLE,
        amount_minor: 8_000,
        currency: 'EGP',
        direction: LedgerDirection.CREDIT,
        status: LedgerEntryStatus.POSTED,
        available_at: new Date(),
        source_channel: PaymentChannel.GATEWAY,
        collection_party: CollectionParty.PLATFORM,
        reference: `cc-teacher-${randomUUID()}`,
        settlement_id: settlement.id,
        metadata: { bank_account: 'must-not-leak' },
      }),
      ledger.create({
        account: 'platform_receivable',
        order_id: order.id,
        payment_id: payment.id,
        teacher_id: teacher.userId,
        entry_type: LedgerEntryType.PLATFORM_RECEIVABLE,
        amount_minor: 2_000,
        currency: 'EGP',
        direction: LedgerDirection.CREDIT,
        status: LedgerEntryStatus.POSTED,
        available_at: new Date(),
        source_channel: PaymentChannel.GATEWAY,
        collection_party: CollectionParty.PLATFORM,
        reference: `cc-platform-${randomUUID()}`,
        settlement_id: settlement.id,
        metadata: null,
      }),
    ]);
    return { student, teacher, admin, support };
  }

  it('returns only allowlisted finance projections to Call Center and denies users without the role', async () => {
    const { student, teacher, support } = await financeFixture();

    await request(server).get(`${API_PREFIX}/callcenter/finance/payments`).expect(401);
    await student.agent.get(`${API_PREFIX}/callcenter/finance/payments`).expect(403);
    await teacher.agent.get(`${API_PREFIX}/callcenter/finance/settlements`).expect(403);

    const payments = await support.agent
      .get(`${API_PREFIX}/callcenter/finance/payments`)
      .expect(200);
    expect(payments.body.data[0]).toMatchObject({
      total_amount_minor: 10_000,
      platform_commission_minor: 2_000,
      teacher_net_receivable_minor: 8_000,
      payment_status: PaymentStatus.COMPLETED,
    });
    expect(payments.body.data[0]).not.toHaveProperty('order_id');
    expect(JSON.stringify(payments.body)).not.toContain('secret-provider-reference');
    expect(JSON.stringify(payments.body)).not.toContain('provider_payload');
    expect(JSON.stringify(payments.body)).not.toContain('idempotency');

    const settlements = await support.agent
      .get(`${API_PREFIX}/callcenter/finance/settlements`)
      .expect(200);
    expect(settlements.body.data[0]).toMatchObject({
      financial_reference: 'SAFE-TRANSFER-REFERENCE',
      teacher_net_receivable_minor: 8_000,
    });
    expect(settlements.body.data[0]).not.toHaveProperty('settlement_id');
    expect(JSON.stringify(settlements.body)).not.toContain('private-proof-key');
    expect(JSON.stringify(settlements.body)).not.toContain('must-not-leak');

    const receivables = await support.agent
      .get(`${API_PREFIX}/callcenter/finance/receivables`)
      .expect(200);
    expect(receivables.body.data[0]).toMatchObject({
      teacher_net_receivable_minor: 8_000,
      platform_receivable_minor: 2_000,
    });
    expect(receivables.body.data[0]).not.toHaveProperty('teacher_id');
  });

  it('cannot use executive finance, settlement, refund, or export endpoints', async () => {
    const { admin, support } = await financeFixture();

    await admin.agent.get(`${API_PREFIX}/admin/finance/orders`).expect(200);
    await support.agent.get(`${API_PREFIX}/admin/finance/orders`).expect(403);
    await support.agent.post(`${API_PREFIX}/admin/finance/settlements`).send({}).expect(403);
    await support.agent
      .post(`${API_PREFIX}/admin/finance/settlements/${randomUUID()}/approve`)
      .send({})
      .expect(403);
    await support.agent
      .post(`${API_PREFIX}/admin/finance/settlements/${randomUUID()}/reject`)
      .send({})
      .expect(403);
    await support.agent.post(`${API_PREFIX}/admin/finance/refunds`).send({}).expect(403);
    await support.agent.get(`${API_PREFIX}/admin/finance/reports/export`).expect(403);
  });
});
