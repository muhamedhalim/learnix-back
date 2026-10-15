import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import {
  CollectionParty,
  Entitlement,
  EntitlementStatus,
  FinancialLedgerEntry,
  GatewayWebhookEvent,
  ItemType,
  Order,
  OrderStatus,
  Payment,
  PaymentChannel,
  PaymentDomainEvent,
  PaymentAuditLog,
  PaymentMethod,
  PaymentStatus,
  Refund,
  RefundAttempt,
  RefundStatus,
  LedgerDirection,
  LedgerEntryStatus,
  LedgerEntryType,
  SettlementEntry,
  Settlement,
  SettlementStatus,
} from '../../src/payments/entities';
import type {
  PaymentGateway,
  ProviderTransactionDetails,
  ProviderWebhookEvent,
} from '../../src/payments/providers/payment-gateway.interface';
import { GatewayFinancialStateMachineService } from '../../src/payments/services/gateway-financial-state-machine.service';
import { GatewayWebhookService } from '../../src/payments/services/gateway-webhook.service';
import { PaymentOperationsService } from '../../src/payments/services/payment-operations.service';
import { PaymentProviderRegistry } from '../../src/payments/services/payment-provider-registry.service';
import { RefundsService } from '../../src/payments/services/refunds.service';
import { SettlementsService } from '../../src/payments/services/settlements.service';
import { createE2EApp, resetDatabase } from './fixtures';

describe('payment financial state machine (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let stateMachine: GatewayFinancialStateMachineService;
  let refunds: RefundsService;
  let operations: PaymentOperationsService;
  let providers: PaymentProviderRegistry;
  let webhooks: GatewayWebhookService;
  let settlements: SettlementsService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    stateMachine = app.get(GatewayFinancialStateMachineService);
    refunds = app.get(RefundsService);
    operations = app.get(PaymentOperationsService);
    providers = app.get(PaymentProviderRegistry);
    webhooks = app.get(GatewayWebhookService);
    settlements = app.get(SettlementsService);
  });

  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  async function fixture(): Promise<{
    payment: Payment;
    order: Order;
    event: GatewayWebhookEvent;
    teacher: User;
    student: User;
  }> {
    const users = dataSource.getRepository(User);
    const teacher = await users.save(
      users.create({
        username: 'teacher-state',
        name: 'Teacher',
        first_name: null,
        last_name: null,
        email: 'teacher-state@example.test',
        phone: '01000000001',
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const student = await users.save(
      users.create({
        username: 'student-state',
        name: 'Student',
        first_name: null,
        last_name: null,
        email: 'student-state@example.test',
        phone: '01000000002',
        role: UserRole.STUDENT,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const subjects = dataSource.getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'State subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
      }),
    );
    const lessons = dataSource.getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'State lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        video_asset_id: null,
        video_status: null,
        video_width: null,
        video_height: null,
        video_thumbnail: null,
        video_size_bytes: null,
        price: 100,
        duration: null,
      }),
    );
    const orders = dataSource.getRepository(Order);
    const order = await orders.save(
      orders.create({
        order_number: 'STATE-ORDER-1',
        student_id: student.id,
        teacher_id: teacher.id,
        item_type: ItemType.LESSON,
        item_id: lesson.id,
        quantity: 1,
        original_amount_minor: 10_000,
        discount_amount_minor: 0,
        final_amount_minor: 10_000,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: 'paymob',
        status: OrderStatus.AWAITING_PAYMENT,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: lesson.title,
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 3000,
        teacher_earning_minor: 7000,
        discount_snapshot: null,
        metadata: { access_duration_days: 7 },
        expires_at: new Date(Date.now() + 60_000),
        paid_at: null,
        cancelled_at: null,
      }),
    );
    const payments = dataSource.getRepository(Payment);
    const payment = await payments.save(
      payments.create({
        order_id: order.id,
        user_id: student.id,
        item_type: ItemType.LESSON,
        item_id: lesson.id,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: 'paymob',
        provider_reference: '555',
        paymob_order_id: '555',
        paymob_transaction_id: null,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        idempotency_key: 'state-payment-key',
        failure_reason: null,
        completed_at: null,
      }),
    );
    order.payment_id = payment.id;
    await orders.save(order);
    const events = dataSource.getRepository(GatewayWebhookEvent);
    const event = await events.save(
      events.create({
        provider: 'paymob',
        provider_event_id: 'state-event-1',
        payment_id: payment.id,
        status: 'processing',
        payload: {},
        error_message: null,
        lease_token: 'lease-1',
        claimed_by: 'test',
        claimed_at: new Date(),
        lease_expires_at: new Date(Date.now() + 60_000),
        heartbeat_at: new Date(),
        next_retry_at: null,
        attempt_count: 1,
        max_attempts: 8,
        last_error: null,
        processed_at: null,
      }),
    );
    return { payment, order, event, teacher, student };
  }

  const webhook = (outcome: ProviderWebhookEvent['outcome']): ProviderWebhookEvent => ({
    provider: 'paymob',
    providerEventId: `provider-${outcome}`,
    merchantReference: 'unused',
    providerOrderReference: '555',
    transactionId: '777',
    amountMinor: 10_000,
    currency: 'EGP',
    occurredAt: new Date(),
    outcome,
    isLive: false,
    payload: {},
  });

  const webhookForPayment = (
    payment: Payment,
    outcome: ProviderWebhookEvent['outcome'],
    providerEventId: string,
  ): ProviderWebhookEvent => ({
    ...webhook(outcome),
    providerEventId,
    merchantReference: payment.id,
  });

  const persistedWebhook = (webhookEvent: ProviderWebhookEvent): Record<string, unknown> => ({
    __payment_recovery: {
      provider: webhookEvent.provider,
      providerEventId: webhookEvent.providerEventId,
      merchantReference: webhookEvent.merchantReference,
      providerOrderReference: webhookEvent.providerOrderReference,
      transactionId: webhookEvent.transactionId,
      amountMinor: webhookEvent.amountMinor,
      currency: webhookEvent.currency,
      occurredAt: webhookEvent.occurredAt?.toISOString() ?? null,
      outcome: webhookEvent.outcome,
      message: null,
    },
  });

  const providerTransaction = (
    payment: Payment,
    status: ProviderTransactionDetails['status'],
  ): ProviderTransactionDetails => ({
    transactionId: '777',
    status,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    occurredAt: new Date(),
    providerOrderReference: payment.paymob_order_id ?? payment.provider_reference!,
    merchantReference: payment.id,
    refundedAmountMinor: status === 'refunded' ? payment.amount_minor : 0,
    isLive: false,
  });

  const mockProviderInquiry = (
    details: ProviderTransactionDetails | null,
  ): jest.SpyInstance<PaymentGateway> =>
    jest.spyOn(providers, 'get').mockReturnValue({
      getTransactionByOrderReference: jest.fn().mockResolvedValue(details),
    } as unknown as PaymentGateway);

  async function availableLedgerEntry(
    order: Order,
    amountMinor: number,
    direction: LedgerDirection,
    reference: string,
  ): Promise<FinancialLedgerEntry> {
    return dataSource.getRepository(FinancialLedgerEntry).save(
      dataSource.getRepository(FinancialLedgerEntry).create({
        account: 'teacher_payable_available',
        order_id: order.id,
        payment_id: order.payment_id,
        teacher_id: order.teacher_id,
        entry_type:
          direction === LedgerDirection.CREDIT
            ? LedgerEntryType.TEACHER_EARNING_AVAILABLE
            : LedgerEntryType.TEACHER_EARNING_REVERSAL,
        amount_minor: amountMinor,
        currency: 'EGP',
        direction,
        status: LedgerEntryStatus.POSTED,
        available_at: new Date(),
        source_channel: PaymentChannel.GATEWAY,
        collection_party: CollectionParty.PLATFORM,
        settlement_id: null,
        reference,
        metadata: null,
      }),
    );
  }

  async function laterOrder(order: Order, suffix: string): Promise<Order> {
    const { id: _id, created_at: _createdAt, updated_at: _updatedAt, ...copy } = order;
    return dataSource.getRepository(Order).save(
      dataSource.getRepository(Order).create({
        ...copy,
        order_number: `STATE-FUTURE-${suffix}`,
        payment_id: null,
        status: OrderStatus.PAID,
        refunded_amount_minor: 0,
        paid_at: new Date(),
      }),
    );
  }

  it('commits a provider refund as one final financial state and is replay-safe', async () => {
    const { payment, order, event } = await fixture();
    await stateMachine.apply(event.id, 'lease-1', payment.id, webhook('refunded'));
    await stateMachine.apply(event.id, 'lease-1', payment.id, webhook('refunded'));

    await expect(
      dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id }),
    ).resolves.toMatchObject({ status: PaymentStatus.REFUNDED });
    await expect(
      dataSource.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).resolves.toMatchObject({ status: OrderStatus.REFUNDED, refunded_amount_minor: 10_000 });
    await expect(
      dataSource.getRepository(Entitlement).findOneByOrFail({ order_id: order.id }),
    ).resolves.toMatchObject({ status: EntitlementStatus.REVOKED });
    expect(await dataSource.getRepository(Refund).countBy({ order_id: order.id })).toBe(1);
    expect(
      await dataSource.getRepository(FinancialLedgerEntry).countBy({ order_id: order.id }),
    ).toBeGreaterThanOrEqual(6);
    await expect(
      dataSource.getRepository(GatewayWebhookEvent).findOneByOrFail({ id: event.id }),
    ).resolves.toMatchObject({ status: 'processed' });
  });

  it('rolls back payment, entitlement, refund, ledger, and webhook completion after a fault', async () => {
    const { payment, order, event } = await fixture();
    const failing = jest
      .spyOn(refunds, 'completeProviderNotificationInTransaction')
      .mockRejectedValueOnce(new Error('fault'));
    await expect(
      stateMachine.apply(event.id, 'lease-1', payment.id, webhook('refunded')),
    ).rejects.toThrow('fault');
    failing.mockRestore();

    await expect(
      dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id }),
    ).resolves.toMatchObject({ status: PaymentStatus.PROCESSING });
    await expect(
      dataSource.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).resolves.toMatchObject({ status: OrderStatus.AWAITING_PAYMENT });
    expect(await dataSource.getRepository(Entitlement).countBy({ order_id: order.id })).toBe(0);
    expect(await dataSource.getRepository(Refund).countBy({ order_id: order.id })).toBe(0);
    expect(
      await dataSource.getRepository(FinancialLedgerEntry).countBy({ order_id: order.id }),
    ).toBe(0);
    await expect(
      dataSource.getRepository(GatewayWebhookEvent).findOneByOrFail({ id: event.id }),
    ).resolves.toMatchObject({ status: 'processing' });
  });

  it('repairs a provider-paid/internal-processing payment through the shared finalizer', async () => {
    const { payment, order } = await fixture();
    const inquiry = mockProviderInquiry(providerTransaction(payment, 'succeeded'));

    await operations.reconcileGatewayAttempts();

    await expect(
      dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id }),
    ).resolves.toMatchObject({
      status: PaymentStatus.COMPLETED,
      reconciliation_status: 'reconciled',
    });
    await expect(
      dataSource.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).resolves.toMatchObject({ status: OrderStatus.PAID });
    await expect(
      dataSource.getRepository(Entitlement).countBy({ order_id: order.id }),
    ).resolves.toBe(1);
    expect(inquiry).toHaveBeenCalled();
    inquiry.mockRestore();
  });

  it('repairs a provider-authoritative full refund without ever using payment success as refund proof', async () => {
    const { payment, order, event } = await fixture();
    await stateMachine.apply(event.id, 'lease-1', payment.id, webhook('succeeded'));
    const refund = await dataSource.getRepository(Refund).save(
      dataSource.getRepository(Refund).create({
        order_id: order.id,
        payment_id: payment.id,
        channel: PaymentChannel.GATEWAY,
        amount_minor: payment.amount_minor,
        currency: payment.currency,
        status: RefundStatus.PROCESSING,
        reason_code: 'test',
        reason: null,
        internal_note: null,
        external_method: null,
        external_reference: null,
        proof_file_key: null,
        requested_by: order.student_id,
        approved_by: null,
        completed_by: null,
        completed_at: null,
        metadata: null,
      }),
    );
    const inquiry = mockProviderInquiry(providerTransaction(payment, 'refunded'));

    await operations.reconcileGatewayAttempts();

    await expect(
      dataSource.getRepository(Refund).findOneByOrFail({ id: refund.id }),
    ).resolves.toMatchObject({
      status: RefundStatus.SUCCEEDED,
      reconciliation_status: 'reconciled',
    });
    await expect(
      dataSource.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).resolves.toMatchObject({ status: OrderStatus.REFUNDED });
    inquiry.mockRestore();
  });

  it('puts a processing refund into reviewed reconciliation when inquiry only proves the original charge', async () => {
    const { payment, order, event } = await fixture();
    await stateMachine.apply(event.id, 'lease-1', payment.id, webhook('succeeded'));
    const refund = await dataSource.getRepository(Refund).save(
      dataSource.getRepository(Refund).create({
        order_id: order.id,
        payment_id: payment.id,
        channel: PaymentChannel.GATEWAY,
        amount_minor: payment.amount_minor,
        currency: payment.currency,
        status: RefundStatus.PROCESSING,
        reason_code: 'test',
        reason: null,
        internal_note: null,
        external_method: null,
        external_reference: null,
        proof_file_key: null,
        requested_by: order.student_id,
        approved_by: null,
        completed_by: null,
        completed_at: null,
        metadata: null,
      }),
    );
    const inquiry = mockProviderInquiry(providerTransaction(payment, 'succeeded'));

    await operations.reconcileGatewayAttempts();

    await expect(
      dataSource.getRepository(Refund).findOneByOrFail({ id: refund.id }),
    ).resolves.toMatchObject({
      status: RefundStatus.PROCESSING,
      reconciliation_status: 'reconciliation_required',
    });
    expect(inquiry).toHaveBeenCalledTimes(1);
    inquiry.mockRestore();
  });

  it('allows exactly one concurrent gateway refund dispatch and retains the durable attempt', async () => {
    const { payment, order, event, teacher, student } = await fixture();
    await stateMachine.apply(event.id, 'lease-1', payment.id, webhook('succeeded'));
    const refund = await refunds.request(
      { order_id: order.id, amount_minor: payment.amount_minor, reason_code: 'test' },
      teacher.id,
    );
    let releaseProvider!: () => void;
    let enteredProvider!: () => void;
    const providerEntered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    const providerCall = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const refundCall = jest.fn(async () => {
      enteredProvider();
      await providerCall;
      return { providerReference: 'refund-777', status: 'succeeded' as const };
    });
    const provider = jest.spyOn(providers, 'get').mockReturnValue({
      supportsRefunds: () => true,
      refund: refundCall,
    } as unknown as PaymentGateway);

    const first = refunds.processGateway(refund.id, student.id);
    await providerEntered;
    await expect(refunds.processGateway(refund.id, student.id)).rejects.toThrow(
      'Gateway refund is already being processed',
    );
    releaseProvider();
    await expect(first).resolves.toMatchObject({ status: RefundStatus.SUCCEEDED });
    expect(refundCall).toHaveBeenCalledTimes(1);
    await expect(
      dataSource.getRepository(RefundAttempt).countBy({ refund_id: refund.id }),
    ).resolves.toBe(1);
    await expect(
      dataSource.getRepository(RefundAttempt).findOneByOrFail({ refund_id: refund.id }),
    ).resolves.toMatchObject({
      status: 'succeeded',
      provider_refund_id: 'refund-777',
    });
    provider.mockRestore();
  });

  it('fails closed after an ambiguous provider timeout and refuses a blind resend', async () => {
    const { payment, order, event, teacher, student } = await fixture();
    await stateMachine.apply(event.id, 'lease-1', payment.id, webhook('succeeded'));
    const refund = await refunds.request(
      { order_id: order.id, amount_minor: payment.amount_minor, reason_code: 'test' },
      teacher.id,
    );
    const refundCall = jest.fn().mockRejectedValue(new Error('provider timeout after send'));
    const provider = jest.spyOn(providers, 'get').mockReturnValue({
      supportsRefunds: () => true,
      refund: refundCall,
    } as unknown as PaymentGateway);

    await expect(refunds.processGateway(refund.id, student.id)).rejects.toThrow(
      'provider timeout after send',
    );
    await expect(refunds.processGateway(refund.id, student.id)).rejects.toThrow(
      'Gateway refund outcome is ambiguous',
    );
    expect(refundCall).toHaveBeenCalledTimes(1);
    await expect(
      dataSource.getRepository(RefundAttempt).findOneByOrFail({ refund_id: refund.id }),
    ).resolves.toMatchObject({
      status: 'reconciliation_required',
      lease_expires_at: null,
    });
    provider.mockRestore();
  });

  it('claims concurrent duplicate webhooks once and reaches one final financial outcome', async () => {
    const { payment, order } = await fixture();
    const incoming = webhookForPayment(payment, 'succeeded', 'concurrent-success-event');

    const results = await Promise.all([webhooks.process(incoming), webhooks.process(incoming)]);

    const statuses = results.map((result) => result.status);
    expect(statuses).toContain('success');
    expect(statuses.some((status) => status === 'pending' || status === 'already_processed')).toBe(
      true,
    );
    await expect(
      dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id }),
    ).resolves.toMatchObject({ status: PaymentStatus.COMPLETED });
    await expect(
      dataSource.getRepository(Entitlement).countBy({ order_id: order.id }),
    ).resolves.toBe(1);
    await expect(
      dataSource.getRepository(FinancialLedgerEntry).countBy({ order_id: order.id }),
    ).resolves.toBe(3);
    await expect(
      dataSource
        .getRepository(GatewayWebhookEvent)
        .countBy({ provider_event_id: incoming.providerEventId }),
    ).resolves.toBe(1);
  });

  it('recovers an expired webhook lease from PostgreSQL without a new provider delivery', async () => {
    const { payment, order } = await fixture();
    const incoming = webhookForPayment(payment, 'succeeded', 'stale-success-event');
    const stale = await dataSource.getRepository(GatewayWebhookEvent).save(
      dataSource.getRepository(GatewayWebhookEvent).create({
        provider: incoming.provider,
        provider_event_id: incoming.providerEventId,
        payment_id: payment.id,
        status: 'processing',
        payload: persistedWebhook(incoming),
        error_message: null,
        lease_token: 'crashed-worker',
        claimed_by: 'crashed-worker',
        claimed_at: new Date(Date.now() - 600_000),
        lease_expires_at: new Date(Date.now() - 1),
        heartbeat_at: new Date(Date.now() - 600_000),
        next_retry_at: null,
        attempt_count: 1,
        max_attempts: 8,
        last_error: null,
        processed_at: null,
      }),
    );

    await expect(webhooks.recoverStaleEvents()).resolves.toBe(1);

    await expect(
      dataSource.getRepository(GatewayWebhookEvent).findOneByOrFail({ id: stale.id }),
    ).resolves.toMatchObject({ status: 'processed' });
    await expect(
      dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id }),
    ).resolves.toMatchObject({ status: PaymentStatus.COMPLETED });
    await expect(
      dataSource.getRepository(Entitlement).countBy({ order_id: order.id }),
    ).resolves.toBe(1);
  });

  it('renews a webhook lease so a second recovery worker cannot steal it', async () => {
    const { payment } = await fixture();
    const event = await dataSource.getRepository(GatewayWebhookEvent).save(
      dataSource.getRepository(GatewayWebhookEvent).create({
        provider: 'paymob',
        provider_event_id: 'heartbeat-event',
        payment_id: payment.id,
        status: 'processing',
        payload: {},
        error_message: null,
        lease_token: 'owner-token',
        claimed_by: 'owner',
        claimed_at: new Date(Date.now() - 600_000),
        lease_expires_at: new Date(Date.now() - 1),
        heartbeat_at: new Date(Date.now() - 600_000),
        next_retry_at: null,
        attempt_count: 1,
        max_attempts: 8,
        last_error: null,
        processed_at: null,
      }),
    );

    await expect(webhooks.heartbeat(event.id, 'owner-token')).resolves.toBe(true);
    await expect(webhooks.recoverStaleEvents()).resolves.toBe(0);
    await expect(
      dataSource.getRepository(GatewayWebhookEvent).findOneByOrFail({ id: event.id }),
    ).resolves.toMatchObject({
      status: 'processing',
      lease_token: 'owner-token',
    });
  });

  it('moves poison events to a deduplicated dead letter alert and supports a reviewed replay', async () => {
    const { payment } = await fixture();
    const incoming = webhookForPayment(payment, 'succeeded', 'manual-replay-event');
    const event = await dataSource.getRepository(GatewayWebhookEvent).save(
      dataSource.getRepository(GatewayWebhookEvent).create({
        provider: incoming.provider,
        provider_event_id: incoming.providerEventId,
        payment_id: payment.id,
        status: 'failed',
        payload: persistedWebhook(incoming),
        error_message: 'poison',
        lease_token: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        heartbeat_at: null,
        next_retry_at: new Date(Date.now() - 1),
        attempt_count: 8,
        max_attempts: 8,
        last_error: 'poison',
        processed_at: null,
      }),
    );

    await expect(webhooks.recoverStaleEvents()).resolves.toBe(0);
    await expect(
      dataSource.getRepository(GatewayWebhookEvent).findOneByOrFail({ id: event.id }),
    ).resolves.toMatchObject({ status: 'dead_letter' });
    await expect(
      dataSource.query(
        'SELECT count(*)::int AS count FROM payment_domain_events WHERE dedupe_key = $1',
        [`webhook:${event.id}:dead-letter`],
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(webhooks.replayDeadLetter(event.id)).resolves.toMatchObject({ status: 'success' });
    await expect(
      dataSource.getRepository(GatewayWebhookEvent).findOneByOrFail({ id: event.id }),
    ).resolves.toMatchObject({ status: 'processed' });
  });

  it('fulfills a signed capture inside the configured expiry grace period', async () => {
    const { payment, order } = await fixture();
    await dataSource.getRepository(Order).update(order.id, {
      status: OrderStatus.EXPIRED,
      expires_at: new Date(Date.now() - 60_000),
    });
    const incoming = {
      ...webhookForPayment(payment, 'succeeded', 'late-within-grace'),
      occurredAt: new Date(),
    };

    await expect(webhooks.process(incoming)).resolves.toMatchObject({ status: 'success' });
    await expect(
      dataSource.getRepository(Order).findOneByOrFail({ id: order.id }),
    ).resolves.toMatchObject({ status: OrderStatus.PAID });
    await expect(
      dataSource.getRepository(Entitlement).countBy({ order_id: order.id }),
    ).resolves.toBe(1);
  });

  it('creates compensation-required recovery instead of granting access after grace or excessive provider clock skew', async () => {
    const { payment, order } = await fixture();
    await dataSource.getRepository(Order).update(order.id, {
      status: OrderStatus.EXPIRED,
      expires_at: new Date(Date.now() - 10 * 60_000),
    });
    const incoming = {
      ...webhookForPayment(payment, 'succeeded', 'late-after-grace'),
      occurredAt: new Date(Date.now() + 10 * 60_000),
    };

    await expect(webhooks.process(incoming)).resolves.toMatchObject({ status: 'pending' });
    await expect(
      dataSource.getRepository(Payment).findOneByOrFail({ id: payment.id }),
    ).resolves.toMatchObject({
      status: PaymentStatus.PROCESSING,
      reconciliation_status: 'reconciliation_required',
    });
    await expect(
      dataSource.getRepository(Entitlement).countBy({ order_id: order.id }),
    ).resolves.toBe(0);
    await expect(
      dataSource.getRepository(Refund).findOneByOrFail({ order_id: order.id }),
    ).resolves.toMatchObject({
      status: RefundStatus.REQUESTED,
      reason_code: 'fulfillment_compensation',
    });
    await expect(
      dataSource
        .getRepository(GatewayWebhookEvent)
        .findOneByOrFail({ provider_event_id: incoming.providerEventId }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('carries a refunded payout debt forward so a later equal earning cannot be paid twice', async () => {
    const { order, teacher, student } = await fixture();
    const future = await laterOrder(order, 'equal');
    await availableLedgerEntry(order, 70_000, LedgerDirection.CREDIT, 'settlement:paid-70');
    await availableLedgerEntry(order, 70_000, LedgerDirection.DEBIT, 'settlement:clearing-70');
    await availableLedgerEntry(order, 70_000, LedgerDirection.DEBIT, 'refund:after-paid-70');
    await availableLedgerEntry(future, 70_000, LedgerDirection.CREDIT, 'earning:after-refund-70');

    await expect(
      settlements.create({ teacher_id: teacher.id, payment_method: 'bank' }, student.id),
    ).rejects.toThrow('Teacher has no positive net payable balance');
  });

  it('caps a settlement at net payable and records a partial earning allocation', async () => {
    const { order, teacher, student } = await fixture();
    const future = await laterOrder(order, 'partial');
    const earning = await availableLedgerEntry(
      future,
      100_000,
      LedgerDirection.CREDIT,
      'earning:100',
    );
    await availableLedgerEntry(order, 70_000, LedgerDirection.DEBIT, 'refund:70');

    const settlement = await settlements.create(
      { teacher_id: teacher.id, payment_method: 'bank', ledger_entry_ids: [earning.id] },
      student.id,
    );

    expect(settlement.gross_amount_minor).toBe(30_000);
    expect(settlement.payout_amount_minor).toBe(30_000);
    await expect(
      dataSource.getRepository(SettlementEntry).findOneByOrFail({ settlement_id: settlement.id }),
    ).resolves.toMatchObject({
      ledger_entry_id: earning.id,
      amount_minor: 30_000,
    });
  });

  it('serializes concurrent settlement creation so one earning allocation is never paid twice', async () => {
    const { order, teacher, student } = await fixture();
    await availableLedgerEntry(order, 100_000, LedgerDirection.CREDIT, 'earning:concurrent-100');

    const results = await Promise.allSettled([
      settlements.create({ teacher_id: teacher.id, payment_method: 'bank' }, student.id),
      settlements.create({ teacher_id: teacher.id, payment_method: 'bank' }, student.id),
    ]);

    // Legacy callers have no random server key any more: the deterministic
    // semantic fallback makes the concurrent retry replay the original row.
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Settlement> => result.status === 'fulfilled',
    );
    expect(fulfilled).toHaveLength(2);
    expect(new Set(fulfilled.map((result) => result.value.id)).size).toBe(1);
    await expect(
      dataSource.query('SELECT count(*)::int AS count FROM teacher_settlement_entries'),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      dataSource.query(
        'SELECT COALESCE(SUM(amount_minor), 0)::int AS amount FROM teacher_settlement_entries',
      ),
    ).resolves.toEqual([{ amount: 100000 }]);
  });

  it('serializes concurrent settlement execution so a transfer is posted once and available balance never becomes negative', async () => {
    const { order, teacher, student } = await fixture();
    const executor = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        username: 'settlement-executor',
        name: 'Executor',
        first_name: null,
        last_name: null,
        email: 'settlement-executor@example.test',
        phone: '01000000003',
        role: UserRole.ADMIN,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    await availableLedgerEntry(order, 20_000, LedgerDirection.CREDIT, 'earning:pay-race');
    const settlement = await settlements.create(
      { teacher_id: teacher.id, payment_method: 'bank', amount_minor: 20_000 },
      student.id,
    );
    await settlements.approve(settlement.id, teacher.id);

    const results = await Promise.allSettled([
      settlements.markPaid(settlement.id, { transfer_reference: 'PAY-RACE-001' }, executor.id),
      settlements.markPaid(settlement.id, { transfer_reference: 'PAY-RACE-001' }, executor.id),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    await expect(
      dataSource.getRepository(Settlement).findOneByOrFail({ id: settlement.id }),
    ).resolves.toMatchObject({
      status: SettlementStatus.PAID,
      transfer_reference: 'PAY-RACE-001',
    });
    await expect(
      dataSource.query(
        'SELECT count(*)::int AS count FROM financial_ledger_entries WHERE reference = $1',
        [`settlement:${settlement.id}:payout`],
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      dataSource.query(
        `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0)::int AS balance
       FROM financial_ledger_entries WHERE teacher_id = $1 AND account = 'teacher_payable_available' AND currency = 'EGP'`,
        [teacher.id],
      ),
    ).resolves.toEqual([{ balance: 0 }]);
  });

  it('serializes concurrent held-earning release workers and posts one release pair', async () => {
    const { order, payment, teacher } = await fixture();
    await dataSource
      .getRepository(Order)
      .update(order.id, { status: OrderStatus.PAID, paid_at: new Date() });
    await dataSource.getRepository(Payment).update(payment.id, { status: PaymentStatus.COMPLETED });
    const pending = await dataSource.getRepository(FinancialLedgerEntry).save(
      dataSource.getRepository(FinancialLedgerEntry).create({
        account: 'teacher_payable',
        order_id: order.id,
        payment_id: payment.id,
        teacher_id: teacher.id,
        entry_type: LedgerEntryType.TEACHER_EARNING_PENDING,
        amount_minor: 7_000,
        currency: 'EGP',
        direction: LedgerDirection.CREDIT,
        status: LedgerEntryStatus.POSTED,
        available_at: new Date(Date.now() - 1_000),
        source_channel: PaymentChannel.GATEWAY,
        collection_party: CollectionParty.PLATFORM,
        settlement_id: null,
        reference: `order:${order.id}:teacher-earning`,
        metadata: null,
      }),
    );

    const releases = await Promise.all([
      settlements.releaseAvailableEarnings(),
      settlements.releaseAvailableEarnings(),
    ]);

    expect(releases.reduce((sum, count) => sum + count, 0)).toBe(1);
    await expect(
      dataSource.query(
        'SELECT count(*)::int AS count FROM financial_ledger_entries WHERE reference = $1',
        [`release:${pending.id}:available`],
      ),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      dataSource.query(
        'SELECT count(*)::int AS count FROM financial_ledger_entries WHERE reference = $1',
        [`release:${pending.id}:pending`],
      ),
    ).resolves.toEqual([{ count: 1 }]);
  });

  it('serializes a refund against settlement allocation without a deadlock or negative available balance', async () => {
    const { order, payment, teacher, student } = await fixture();
    await dataSource
      .getRepository(Order)
      .update(order.id, { status: OrderStatus.PAID, paid_at: new Date() });
    await dataSource.getRepository(Payment).update(payment.id, { status: PaymentStatus.COMPLETED });
    const earning = await availableLedgerEntry(
      order,
      10_000,
      LedgerDirection.CREDIT,
      `order:${order.id}:teacher-earning`,
    );
    const refund = await refunds.request(
      { order_id: order.id, amount_minor: 10_000, reason_code: 'test' },
      student.id,
    );

    const results = await Promise.allSettled([
      refunds.complete(
        refund.id,
        { external_method: 'manual', external_reference: 'REFUND-RACE-001' },
        teacher.id,
        true,
      ),
      settlements.create(
        { teacher_id: teacher.id, payment_method: 'bank', ledger_entry_ids: [earning.id] },
        student.id,
      ),
    ]);

    expect(
      results.some(
        (result) => result.status === 'rejected' && String(result.reason).includes('deadlock'),
      ),
    ).toBe(false);
    expect(await dataSource.getRepository(Refund).findOneByOrFail({ id: refund.id })).toMatchObject(
      {
        status: RefundStatus.SUCCEEDED,
      },
    );
    const balance = await dataSource.query(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE -amount_minor END), 0)::int AS balance
       FROM financial_ledger_entries WHERE teacher_id = $1 AND account = 'teacher_payable_available' AND currency = 'EGP'`,
      [teacher.id],
    );
    expect(balance[0].balance).toBeGreaterThanOrEqual(0);
    const allocation = await dataSource.query(
      'SELECT COALESCE(SUM(amount_minor), 0)::int AS amount FROM teacher_settlement_entries WHERE ledger_entry_id = $1',
      [earning.id],
    );
    expect(allocation[0].amount).toBeLessThanOrEqual(earning.amount_minor);
  });

  it('cancels a settlement through the terminal workflow, preserves allocation history, and records its reason', async () => {
    const { order, teacher, student } = await fixture();
    const operator = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        username: 'settlement-canceller',
        name: 'Canceller',
        first_name: null,
        last_name: null,
        email: 'settlement-canceller@example.test',
        phone: '01000000004',
        role: UserRole.ADMIN,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
    const earning = await availableLedgerEntry(
      order,
      20_000,
      LedgerDirection.CREDIT,
      'earning:cancel-audit',
    );
    const settlement = await settlements.create(
      { teacher_id: teacher.id, payment_method: 'bank', ledger_entry_ids: [earning.id] },
      student.id,
    );

    await expect(
      settlements.cancel(settlement.id, { reason: 'Duplicate payout draft' }, operator.id),
    ).resolves.toMatchObject({
      status: SettlementStatus.CANCELLED,
    });
    await expect(
      dataSource.getRepository(SettlementEntry).countBy({ settlement_id: settlement.id }),
    ).resolves.toBe(1);
    await expect(
      dataSource.getRepository(PaymentAuditLog).findOneByOrFail({
        resource_id: settlement.id,
        action: 'settlement_cancelled',
      }),
    ).resolves.toMatchObject({
      details: expect.objectContaining({ reason: 'Duplicate payout draft' }),
    });
  });

  it('claims a financial outbox event once across workers and recovers a stale lease', async () => {
    const events = dataSource.getRepository(PaymentDomainEvent);
    const pending = await events.save(
      events.create({
        event_name: 'test.payment.outbox',
        dedupe_key: 'test:outbox:pending',
        payload: {},
        published_at: null,
        attempts: 0,
        last_error: null,
        status: 'pending',
        lease_token: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        next_retry_at: null,
        failed_at: null,
      }),
    );
    const stale = await events.save(
      events.create({
        event_name: 'test.payment.outbox.stale',
        dedupe_key: 'test:outbox:stale',
        payload: {},
        published_at: null,
        attempts: 1,
        last_error: null,
        status: 'processing',
        lease_token: 'dead-worker',
        claimed_by: 'dead-worker',
        claimed_at: new Date(Date.now() - 600_000),
        lease_expires_at: new Date(Date.now() - 1),
        next_retry_at: null,
        failed_at: null,
      }),
    );

    const published = await Promise.all([operations.publishOutbox(), operations.publishOutbox()]);

    expect(published.reduce((sum, value) => sum + value, 0)).toBe(2);
    await expect(events.findOneByOrFail({ id: pending.id })).resolves.toMatchObject({
      status: 'published',
      attempts: 1,
    });
    await expect(events.findOneByOrFail({ id: stale.id })).resolves.toMatchObject({
      status: 'published',
      attempts: 2,
    });
  });

  it('moves exhausted financial outbox work to a deduplicated dead letter alert', async () => {
    const events = dataSource.getRepository(PaymentDomainEvent);
    const poison = await events.save(
      events.create({
        event_name: 'test.payment.outbox.poison',
        dedupe_key: 'test:outbox:poison',
        payload: {},
        published_at: null,
        attempts: 8,
        last_error: 'poison',
        status: 'failed',
        lease_token: null,
        claimed_by: null,
        claimed_at: null,
        lease_expires_at: null,
        next_retry_at: new Date(Date.now() - 1),
        failed_at: null,
      }),
    );

    await expect(operations.publishOutbox()).resolves.toBe(0);
    await expect(events.findOneByOrFail({ id: poison.id })).resolves.toMatchObject({
      status: 'dead_letter',
    });
    await expect(
      dataSource.query(
        'SELECT count(*)::int AS count FROM payment_domain_events WHERE dedupe_key = $1',
        [`outbox:${poison.id}:dead-letter`],
      ),
    ).resolves.toEqual([{ count: 1 }]);
  });
});
