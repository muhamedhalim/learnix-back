import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FindOperator } from 'typeorm';

import { Certificate } from '../../certificates/entities/certificate.entity';
import { CertificateStatus } from '../../certificates/entities/certificate-status.enum';
import { Payment } from '../../payments/entities/payment.entity';
import { MarketplaceEnrollment, MarketplaceOrder } from '../commerce/entities';
import {
  InstructorEarningStatus,
  MarketplaceEnrollmentStatus,
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryType,
  MarketplaceOrderStatus,
  RefundRequestStatus,
} from '../common/enums';
import { InstructorEarning } from '../earnings/entities/instructor-earning.entity';
import {
  MarketplaceRefundAwaitingPayoutEvent,
  MarketplaceRefundCompletedEvent,
  MarketplaceRefundFailedEvent,
} from '../events/domain.events';
import { MarketplaceCourseReview } from '../reviews/entities/marketplace-course-review.entity';
import { MarketplaceRefundRequest } from './entities';
import { MANUAL_REFUND_REQUIRED, RefundProcessingService } from './refund-processing.service';

function defaultRefundRequest(
  overrides: Partial<MarketplaceRefundRequest> = {},
): MarketplaceRefundRequest {
  return {
    id: 'refund-1',
    order_id: 'order-1',
    enrollment_id: 'enrollment-1',
    learner_id: 'learner-1',
    reason: 'Not what I expected',
    status: RefundRequestStatus.APPROVED,
    is_discretionary: false,
    is_removal_driven: false,
    elapsed_days_at_request: 2,
    progress_bps_at_request: 500,
    progress_bps_at_processing: null,
    eligibility_verdict: {},
    decided_by: null,
    decided_at: null,
    refund_reference: null,
    failure_reason: null,
    ...overrides,
  } as MarketplaceRefundRequest;
}

function defaultOrder(overrides: Partial<MarketplaceOrder> = {}): MarketplaceOrder {
  return {
    id: 'order-1',
    learner_id: 'learner-1',
    course_id: 'course-1',
    instructor_id: 'instructor-1',
    status: MarketplaceOrderStatus.PAID,
    net_amount_minor: 5000,
    commission_amount_minor: 1500,
    instructor_earning_minor: 3500,
    currency: 'EGP',
    is_zero_value: false,
    payment_id: 'payment-1',
    paid_at: new Date('2026-01-01T00:00:00.000Z'),
    refunded_at: null,
    ...overrides,
  } as MarketplaceOrder;
}

function defaultEnrollment(overrides: Partial<MarketplaceEnrollment> = {}): MarketplaceEnrollment {
  return {
    id: 'enrollment-1',
    learner_id: 'learner-1',
    course_id: 'course-1',
    order_id: 'order-1',
    status: MarketplaceEnrollmentStatus.ACTIVE,
    progress_bps: 500,
    revoked_at: null,
    revocation_reason: null,
    ...overrides,
  } as MarketplaceEnrollment;
}

function defaultEarning(overrides: Record<string, unknown> = {}): InstructorEarning {
  return {
    id: 'earning-1',
    instructor_id: 'instructor-1',
    order_id: 'order-1',
    gross_amount_minor: 5000,
    commission_amount_minor: 1500,
    net_amount_minor: 3500,
    currency: 'EGP',
    status: InstructorEarningStatus.PENDING_EARNINGS,
    reversed_at: null,
    reversal_reason: null,
    ...overrides,
  } as InstructorEarning;
}

function defaultPayment(overrides: Record<string, unknown> = {}): Payment {
  return {
    id: 'payment-1',
    provider: 'easykash',
    provider_reference: '123456',
    ...overrides,
  } as Payment;
}

interface ManagerState {
  refundRequest: MarketplaceRefundRequest | null;
  order: MarketplaceOrder | null;
  enrollment: MarketplaceEnrollment | null;
  certificate: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  earning: InstructorEarning | null;
  /** Another COMPLETED request for the same order, returned to the `id: Not(...)` sibling lookup only. */
  completedSibling?: MarketplaceRefundRequest | null;
  /** The payment behind the order, read through the manager by `completeManually`. */
  payment?: Payment | null;
  /** Another request that already used the refund reference, returned to the `refund_reference` lookup only. */
  referenceHolder?: MarketplaceRefundRequest | null;
}

function buildManager(state: ManagerState) {
  const saved: Record<string, unknown[]> = {
    MarketplaceRefundRequest: [],
    MarketplaceOrder: [],
    MarketplaceEnrollment: [],
    Certificate: [],
    MarketplaceCourseReview: [],
    InstructorEarning: [],
  };
  const stateKeyByEntity = new Map<unknown, keyof ManagerState>([
    [MarketplaceRefundRequest, 'refundRequest'],
    [MarketplaceOrder, 'order'],
    [MarketplaceEnrollment, 'enrollment'],
    [Certificate, 'certificate'],
    [MarketplaceCourseReview, 'review'],
    [InstructorEarning, 'earning'],
    [Payment, 'payment'],
  ]);

  const manager = {
    findOne: jest.fn(async (entity: new () => unknown, options?: { where?: { id?: unknown; refund_reference?: unknown } }) => {
      if (entity === MarketplaceRefundRequest && options?.where?.refund_reference !== undefined) {
        return state.referenceHolder ?? null;
      }
      if (entity === MarketplaceRefundRequest && options?.where?.id instanceof FindOperator) {
        return state.completedSibling ?? null;
      }
      const key = stateKeyByEntity.get(entity);
      if (!key) throw new Error(`unexpected entity requested: ${String(entity)}`);
      return state[key];
    }),
    save: jest.fn(async (entity: new () => unknown, data: Record<string, unknown>) => {
      const key = stateKeyByEntity.get(entity);
      if (!key) throw new Error(`unexpected entity saved: ${String(entity)}`);
      saved[(entity as { name: string }).name]!.push(data);
      (state as never)[key] = data;
      return data;
    }),
  };
  return { manager, state, saved };
}

function buildDataSource(
  manager: unknown,
  order: MarketplaceOrder | null,
  payment: Payment | null,
) {
  const orderRepo = { findOne: jest.fn().mockResolvedValue(order) };
  const paymentRepo = { findOne: jest.fn().mockResolvedValue(payment) };
  return {
    transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)),
    getRepository: jest.fn((entity: { name: string }) => {
      if (entity.name === 'MarketplaceOrder') return orderRepo;
      if (entity.name === 'Payment') return paymentRepo;
      throw new Error(`unexpected repository requested: ${entity.name}`);
    }),
  };
}

function buildLedger() {
  const calls: unknown[] = [];
  return {
    post: jest.fn(async (input: unknown) => {
      calls.push(input);
      return { id: `ledger-${calls.length}`, ...(input as object) };
    }),
    calls,
  };
}

function buildActivityLogs() {
  return { recordAuditEvent: jest.fn().mockResolvedValue(undefined) };
}

function buildBalance() {
  return { recordShortfall: jest.fn().mockResolvedValue(undefined) };
}

function buildProviders(
  refundImpl: () => Promise<{ status: 'succeeded' | 'processing'; providerReference: string }>,
) {
  const provider = {
    supportsRefunds: jest.fn().mockReturnValue(true),
    refund: jest.fn(refundImpl),
  };
  const providers = { get: jest.fn().mockReturnValue(provider) };
  return { providers, provider };
}

describe('RefundProcessingService (T136, T137, T138)', () => {
  it('reverses everything atomically once the gateway confirms success (T136, FR-187 – FR-191)', async () => {
    const { manager, state } = buildManager({
      refundRequest: defaultRefundRequest(),
      order: defaultOrder(),
      enrollment: defaultEnrollment(),
      certificate: { status: CertificateStatus.ISSUED, is_public: true },
      review: { withdrawn_at: null },
      earning: defaultEarning(),
    });
    const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
    const ledger = buildLedger();
    const balance = buildBalance();
    const eventEmitter = new EventEmitter2();
    const emitted: unknown[] = [];
    eventEmitter.on(MarketplaceRefundCompletedEvent.EVENT_NAME, (e: unknown) => emitted.push(e));
    const { providers, provider } = buildProviders(async () => ({
      status: 'succeeded',
      providerReference: 'refund-ext-1',
    }));

    const service = new RefundProcessingService(
      dataSource as never,
      ledger as never,
      balance as never,
      providers as never,
      eventEmitter,
      buildActivityLogs() as never,
    );
    const result = await service.process('refund-1');

    expect(provider.refund).toHaveBeenCalledWith(
      expect.objectContaining({
        providerReference: '123456',
        amountMinor: 5000,
        currency: 'EGP',
        idempotencyKey: 'marketplace-refund:refund-1',
      }),
    );
    expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.REFUNDED);
    expect((state.enrollment as MarketplaceEnrollment).status).toBe(
      MarketplaceEnrollmentStatus.REVOKED,
    );
    expect((state.certificate as Record<string, unknown>).status).toBe(CertificateStatus.REVOKED);
    expect((state.review as Record<string, unknown>).withdrawn_at).not.toBeNull();
    expect((state.earning as InstructorEarning).status).toBe(InstructorEarningStatus.REVERSED);
    expect(ledger.calls).toEqual([
      expect.objectContaining({
        entryType: MarketplaceLedgerEntryType.REFUND,
        amountMinor: 3500,
        direction: MarketplaceLedgerDirection.CREDIT,
      }),
      expect.objectContaining({
        entryType: MarketplaceLedgerEntryType.REFUND_COMMISSION_REVERSAL,
        amountMinor: 1500,
        direction: MarketplaceLedgerDirection.CREDIT,
      }),
    ]);
    expect(balance.recordShortfall).not.toHaveBeenCalled();
    expect(result.status).toBe(RefundRequestStatus.COMPLETED);
    expect(result.refund_reference).toBe('refund-ext-1');
    expect(emitted).toHaveLength(1);
  });

  it('never edits the original sale/commission entries — reversal posts new rows only', async () => {
    const { manager } = buildManager({
      refundRequest: defaultRefundRequest(),
      order: defaultOrder(),
      enrollment: defaultEnrollment(),
      certificate: null,
      review: null,
      earning: defaultEarning(),
    });
    const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
    const ledger = buildLedger();
    const { providers } = buildProviders(async () => ({
      status: 'succeeded',
      providerReference: 'ref',
    }));
    const service = new RefundProcessingService(
      dataSource as never,
      ledger as never,
      buildBalance() as never,
      providers as never,
      new EventEmitter2(),
      buildActivityLogs() as never,
    );

    await service.process('refund-1');

    for (const call of ledger.calls as { reference: string }[]) {
      expect(call.reference).toContain('refund-1');
    }
  });

  it('records a shortfall in full when the reversed earning was already paid out (T139)', async () => {
    const { manager } = buildManager({
      refundRequest: defaultRefundRequest(),
      order: defaultOrder(),
      enrollment: defaultEnrollment(),
      certificate: null,
      review: null,
      earning: defaultEarning({ status: InstructorEarningStatus.PAID_OUT }),
    });
    const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
    const balance = buildBalance();
    const { providers } = buildProviders(async () => ({
      status: 'succeeded',
      providerReference: 'ref',
    }));
    const service = new RefundProcessingService(
      dataSource as never,
      buildLedger() as never,
      balance as never,
      providers as never,
      new EventEmitter2(),
      buildActivityLogs() as never,
    );

    await service.process('refund-1');

    expect(balance.recordShortfall).toHaveBeenCalledWith(
      manager,
      'instructor-1',
      3500,
      'EGP',
      'refund-1',
    );
  });

  describe('idempotency (T137)', () => {
    it('short-circuits a request that is already COMPLETED — no gateway call, no re-reversal', async () => {
      const { manager } = buildManager({
        refundRequest: defaultRefundRequest({
          status: RefundRequestStatus.COMPLETED,
          refund_reference: 'already-done',
        }),
        order: defaultOrder({ status: MarketplaceOrderStatus.REFUNDED }),
        enrollment: defaultEnrollment({ status: MarketplaceEnrollmentStatus.REVOKED }),
        certificate: null,
        review: null,
        earning: defaultEarning({ status: InstructorEarningStatus.REVERSED }),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const ledger = buildLedger();
      const { providers, provider } = buildProviders(async () => ({
        status: 'succeeded',
        providerReference: 'x',
      }));
      const service = new RefundProcessingService(
        dataSource as never,
        ledger as never,
        buildBalance() as never,
        providers as never,
        new EventEmitter2(),
        buildActivityLogs() as never,
      );

      const result = await service.process('refund-1');

      expect(result.refund_reference).toBe('already-done');
      expect(provider.refund).not.toHaveBeenCalled();
      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('refuses a concurrent call while a request is already PROCESSING', async () => {
      const { manager } = buildManager({
        refundRequest: defaultRefundRequest({ status: RefundRequestStatus.PROCESSING }),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const { providers, provider } = buildProviders(async () => ({
        status: 'succeeded',
        providerReference: 'x',
      }));
      const service = new RefundProcessingService(
        dataSource as never,
        buildLedger() as never,
        buildBalance() as never,
        providers as never,
        new EventEmitter2(),
        buildActivityLogs() as never,
      );

      await expect(service.process('refund-1')).rejects.toThrow(ConflictException);
      expect(provider.refund).not.toHaveBeenCalled();
    });

    it('refuses a request that has not yet been approved', async () => {
      const { manager } = buildManager({
        refundRequest: defaultRefundRequest({ status: RefundRequestStatus.REQUESTED }),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const service = new RefundProcessingService(
        dataSource as never,
        buildLedger() as never,
        buildBalance() as never,
        buildProviders(async () => ({ status: 'succeeded', providerReference: 'x' }))
          .providers as never,
        new EventEmitter2(),
        buildActivityLogs() as never,
      );

      await expect(service.process('refund-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('provider-failure handling (T138)', () => {
    it('fails closed with no reversal and no ledger entry when the gateway throws', async () => {
      const { manager, state } = buildManager({
        refundRequest: defaultRefundRequest(),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const ledger = buildLedger();
      const eventEmitter = new EventEmitter2();
      const emitted: unknown[] = [];
      eventEmitter.on(MarketplaceRefundFailedEvent.EVENT_NAME, (e: unknown) => emitted.push(e));
      const { providers } = buildProviders(async () => {
        throw new Error('Gateway timed out');
      });

      const service = new RefundProcessingService(
        dataSource as never,
        ledger as never,
        buildBalance() as never,
        providers as never,
        eventEmitter,
        buildActivityLogs() as never,
      );
      const result = await service.process('refund-1');

      expect(result.status).toBe(RefundRequestStatus.FAILED);
      expect(result.failure_reason).toContain('Gateway timed out');
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.PAID);
      expect((state.enrollment as MarketplaceEnrollment).status).toBe(
        MarketplaceEnrollmentStatus.ACTIVE,
      );
      expect((state.earning as InstructorEarning).status).toBe(
        InstructorEarningStatus.PENDING_EARNINGS,
      );
      expect(ledger.post).not.toHaveBeenCalled();
      expect(emitted).toHaveLength(1);
    });

    it('fails closed when the gateway accepts but does not confirm the refund', async () => {
      const { manager, state } = buildManager({
        refundRequest: defaultRefundRequest(),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const ledger = buildLedger();
      const { providers } = buildProviders(async () => ({
        status: 'processing',
        providerReference: 'pending-1',
      }));

      const service = new RefundProcessingService(
        dataSource as never,
        ledger as never,
        buildBalance() as never,
        providers as never,
        new EventEmitter2(),
        buildActivityLogs() as never,
      );
      const result = await service.process('refund-1');

      expect(result.status).toBe(RefundRequestStatus.FAILED);
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.PAID);
      expect(ledger.post).not.toHaveBeenCalled();
    });

    it('fails closed when the order has no reconcilable provider reference', async () => {
      const { manager } = buildManager({
        refundRequest: defaultRefundRequest(),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), null);
      const { providers, provider } = buildProviders(async () => ({
        status: 'succeeded',
        providerReference: 'x',
      }));

      const service = new RefundProcessingService(
        dataSource as never,
        buildLedger() as never,
        buildBalance() as never,
        providers as never,
        new EventEmitter2(),
        buildActivityLogs() as never,
      );
      const result = await service.process('refund-1');

      expect(result.status).toBe(RefundRequestStatus.FAILED);
      expect(provider.refund).not.toHaveBeenCalled();
    });

    it('retrying a FAILED request succeeds cleanly once the gateway cooperates', async () => {
      const { manager, state } = buildManager({
        refundRequest: defaultRefundRequest({
          status: RefundRequestStatus.FAILED,
          failure_reason: 'previous timeout',
        }),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const ledger = buildLedger();
      const { providers } = buildProviders(async () => ({
        status: 'succeeded',
        providerReference: 'ref-2',
      }));

      const service = new RefundProcessingService(
        dataSource as never,
        ledger as never,
        buildBalance() as never,
        providers as never,
        new EventEmitter2(),
        buildActivityLogs() as never,
      );
      const result = await service.process('refund-1');

      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.REFUNDED);
      expect(ledger.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('one refund per order (FIA-009)', () => {
    function serviceFor(
      manager: unknown,
      refundImpl = async () => ({ status: 'succeeded' as const, providerReference: 'ref-2' }),
    ) {
      const ledger = buildLedger();
      const { providers, provider } = buildProviders(refundImpl);
      const events = new EventEmitter2();
      const emitted: string[] = [];
      events.onAny((event) => emitted.push(String(event)));
      const service = new RefundProcessingService(
        buildDataSource(
          manager,
          defaultOrder({ status: MarketplaceOrderStatus.REFUNDED }),
          defaultPayment(),
        buildActivityLogs() as never,
        ) as never,
        ledger as never,
        buildBalance() as never,
        providers as never,
        events,
      );
      return { service, ledger, provider, emitted };
    }

    it('never sends a second refund when another request for the order already completed', async () => {
      const { manager, saved } = buildManager({
        // The learner's first attempt failed at the provider; a second request then refunded the order.
        refundRequest: defaultRefundRequest({
          status: RefundRequestStatus.FAILED,
          failure_reason: 'provider outage',
        }),
        order: defaultOrder({ status: MarketplaceOrderStatus.REFUNDED, refunded_at: new Date() }),
        enrollment: defaultEnrollment({ status: MarketplaceEnrollmentStatus.REVOKED }),
        certificate: null,
        review: null,
        earning: defaultEarning({ status: InstructorEarningStatus.REVERSED }),
        completedSibling: defaultRefundRequest({
          id: 'refund-0',
          status: RefundRequestStatus.COMPLETED,
        }),
      });
      const { service, ledger, provider, emitted } = serviceFor(manager);

      const result = await service.process('refund-1');

      expect(provider.refund).not.toHaveBeenCalled();
      expect(ledger.post).not.toHaveBeenCalled();
      expect(result.status).toBe(RefundRequestStatus.FAILED);
      expect(result.failure_reason).toContain('refund-0');
      expect(saved.MarketplaceRefundRequest).not.toContainEqual(
        expect.objectContaining({ status: RefundRequestStatus.PROCESSING }),
      );
      expect(emitted).not.toContain(MarketplaceRefundFailedEvent.EVENT_NAME);
    });

    it('never sends a refund for an order already marked refunded, even with no sibling request on record', async () => {
      const { manager } = buildManager({
        refundRequest: defaultRefundRequest({ status: RefundRequestStatus.APPROVED }),
        order: defaultOrder({ status: MarketplaceOrderStatus.REFUNDED, refunded_at: new Date() }),
        enrollment: defaultEnrollment(),
        certificate: null,
        review: null,
        earning: defaultEarning(),
      });
      const { service, provider } = serviceFor(manager);

      const result = await service.process('refund-1');

      expect(provider.refund).not.toHaveBeenCalled();
      expect(result.status).toBe(RefundRequestStatus.FAILED);
      expect(result.failure_reason).toMatch(/already refunded/);
    });
  });

  describe('gateway without a refund API (D1)', () => {
    function setup(overrides: { supportsRefunds: boolean }) {
      const { manager, state } = buildManager({
        refundRequest: defaultRefundRequest({ status: RefundRequestStatus.APPROVED }),
        order: defaultOrder(),
        enrollment: defaultEnrollment(),
        certificate: { status: CertificateStatus.ISSUED, is_public: true },
        review: { withdrawn_at: null },
        earning: defaultEarning(),
        payment: defaultPayment(),
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const ledger = buildLedger();
      const eventEmitter = new EventEmitter2();
      const awaiting: unknown[] = [];
      const failed: unknown[] = [];
      eventEmitter.on(MarketplaceRefundAwaitingPayoutEvent.EVENT_NAME, (e: unknown) => awaiting.push(e));
      eventEmitter.on(MarketplaceRefundFailedEvent.EVENT_NAME, (e: unknown) => failed.push(e));
      const { providers, provider } = buildProviders(async () => ({ status: 'succeeded', providerReference: 'x' }));
      provider.supportsRefunds.mockReturnValue(overrides.supportsRefunds);
      const activityLogs = buildActivityLogs();
      const service = new RefundProcessingService(
        dataSource as never,
        ledger as never,
        buildBalance() as never,
        providers as never,
        eventEmitter,
        activityLogs as never,
      );
      return { service, state, manager, ledger, provider, awaiting, failed, activityLogs };
    }

    it('parks the request approved and waiting, instead of failing it, and tells the learner it is on its way', async () => {
      const { service, state, provider, awaiting, failed, ledger } = setup({ supportsRefunds: false });

      const result = await service.process('refund-1');

      expect(provider.refund).not.toHaveBeenCalled();
      expect(result.status).toBe(RefundRequestStatus.APPROVED);
      expect(result.failure_reason).toBe(MANUAL_REFUND_REQUIRED);
      expect(failed).toHaveLength(0);
      expect(awaiting).toHaveLength(1);
      // Nothing is reversed while the money has not moved.
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.PAID);
      expect((state.enrollment as MarketplaceEnrollment).status).toBe(MarketplaceEnrollmentStatus.ACTIVE);
      expect((state.earning as InstructorEarning).status).toBe(InstructorEarningStatus.PENDING_EARNINGS);
      expect(ledger.calls).toHaveLength(0);
    });

    it('tells the learner once, however often the request is processed again', async () => {
      const { service, awaiting } = setup({ supportsRefunds: false });
      await service.process('refund-1');
      await service.process('refund-1');
      expect(awaiting).toHaveLength(1);
    });

    it('still sends a refund to a gateway that can do it by API', async () => {
      const { service, provider, awaiting } = setup({ supportsRefunds: true });
      await service.process('refund-1');
      expect(provider.refund).toHaveBeenCalledTimes(1);
      expect(awaiting).toHaveLength(0);
    });
  });

  describe('completeManually (D1)', () => {
    function setup(
      options: {
        request?: Partial<MarketplaceRefundRequest>;
        order?: Partial<MarketplaceOrder>;
        payment?: Payment | null;
        supportsRefunds?: boolean;
        completedSibling?: MarketplaceRefundRequest | null;
        referenceHolder?: MarketplaceRefundRequest | null;
        earning?: InstructorEarning;
      } = {},
    ) {
      const { manager, state } = buildManager({
        refundRequest: defaultRefundRequest({
          status: RefundRequestStatus.APPROVED,
          failure_reason: MANUAL_REFUND_REQUIRED,
          ...options.request,
        }),
        order: defaultOrder(options.order),
        enrollment: defaultEnrollment(),
        certificate: { status: CertificateStatus.ISSUED, is_public: true },
        review: { withdrawn_at: null },
        earning: options.earning ?? defaultEarning(),
        payment: options.payment === undefined ? defaultPayment() : options.payment,
        completedSibling: options.completedSibling ?? null,
        referenceHolder: options.referenceHolder ?? null,
      });
      const dataSource = buildDataSource(manager, defaultOrder(), defaultPayment());
      const ledger = buildLedger();
      const balance = buildBalance();
      const eventEmitter = new EventEmitter2();
      const completed: unknown[] = [];
      eventEmitter.on(MarketplaceRefundCompletedEvent.EVENT_NAME, (e: unknown) => completed.push(e));
      const { providers, provider } = buildProviders(async () => ({ status: 'succeeded', providerReference: 'x' }));
      provider.supportsRefunds.mockReturnValue(options.supportsRefunds ?? false);
      const activityLogs = buildActivityLogs();
      const service = new RefundProcessingService(
        dataSource as never,
        ledger as never,
        balance as never,
        providers as never,
        eventEmitter,
        activityLogs as never,
      );
      return { service, state, ledger, balance, provider, completed, activityLogs };
    }

    it('reverses access, certificate, review and earning once the payout is recorded, and audits who did it', async () => {
      const { service, state, ledger, provider, completed, activityLogs } = setup();

      const result = await service.completeManually('admin-1', 'refund-1', 'BANK-TRANSFER-8841');

      expect(provider.refund).not.toHaveBeenCalled();
      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
      expect(result.refund_reference).toBe('BANK-TRANSFER-8841');
      expect(result.failure_reason).toBeNull();
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.REFUNDED);
      expect((state.enrollment as MarketplaceEnrollment).status).toBe(MarketplaceEnrollmentStatus.REVOKED);
      expect((state.certificate as Record<string, unknown>).status).toBe(CertificateStatus.REVOKED);
      expect((state.review as Record<string, unknown>).withdrawn_at).not.toBeNull();
      expect((state.earning as InstructorEarning).status).toBe(InstructorEarningStatus.REVERSED);
      expect(ledger.calls).toHaveLength(2);
      expect(completed).toHaveLength(1);
      expect(activityLogs.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: 'admin-1',
          action: 'marketplace_refund_manually_completed',
          targetId: 'refund-1',
          details: expect.objectContaining({ refundReference: 'BANK-TRANSFER-8841', amountMinor: 5000, currency: 'EGP' }),
        }),
      );
    });

    it('also completes a request that had been marked FAILED', async () => {
      const { service } = setup({ request: { status: RefundRequestStatus.FAILED, failure_reason: 'old provider error' } });
      const result = await service.completeManually('admin-1', 'refund-1', 'REF-1');
      expect(result.status).toBe(RefundRequestStatus.COMPLETED);
      expect(result.failure_reason).toBeNull();
    });

    it('requires a reference', async () => {
      const { service, state } = setup();
      await expect(service.completeManually('admin-1', 'refund-1', '   ')).rejects.toMatchObject({ status: 400 });
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.PAID);
    });

    it('is idempotent for the same reference and refuses a different one on a completed refund', async () => {
      const { service, activityLogs, ledger } = setup({
        request: { status: RefundRequestStatus.COMPLETED, refund_reference: 'REF-1', failure_reason: null },
      });
      const again = await service.completeManually('admin-1', 'refund-1', 'REF-1');
      expect(again.status).toBe(RefundRequestStatus.COMPLETED);
      expect(activityLogs.recordAuditEvent).not.toHaveBeenCalled();
      expect(ledger.calls).toHaveLength(0);
      await expect(service.completeManually('admin-1', 'refund-1', 'REF-2')).rejects.toMatchObject({ status: 409 });
    });

    it.each([
      ['processing', RefundRequestStatus.PROCESSING],
      ['requested', RefundRequestStatus.REQUESTED],
      ['rejected', RefundRequestStatus.REJECTED],
    ])('refuses a request that is %s', async (_label, status) => {
      const { service, state } = setup({ request: { status } });
      await expect(service.completeManually('admin-1', 'refund-1', 'REF-1')).rejects.toMatchObject({ status: 409 });
      expect((state.order as MarketplaceOrder).status).toBe(MarketplaceOrderStatus.PAID);
    });

    it('refuses when the gateway can refund through its API, so it cannot be used to skip a real refund', async () => {
      const { service, state } = setup({ supportsRefunds: true });
      await expect(service.completeManually('admin-1', 'refund-1', 'REF-1')).rejects.toMatchObject({ status: 409 });
      expect((state.enrollment as MarketplaceEnrollment).status).toBe(MarketplaceEnrollmentStatus.ACTIVE);
    });

    it('refuses an order with no payment behind it', async () => {
      const { service } = setup({ payment: null });
      await expect(service.completeManually('admin-1', 'refund-1', 'REF-1')).rejects.toMatchObject({ status: 409 });
    });

    it('never refunds an order twice: not when it is already refunded, nor when another request completed', async () => {
      const refunded = setup({ order: { status: MarketplaceOrderStatus.REFUNDED } });
      await expect(refunded.service.completeManually('admin-1', 'refund-1', 'REF-1')).rejects.toMatchObject({ status: 409 });
      const sibling = setup({ completedSibling: defaultRefundRequest({ id: 'refund-0', status: RefundRequestStatus.COMPLETED }) });
      await expect(sibling.service.completeManually('admin-1', 'refund-1', 'REF-1')).rejects.toMatchObject({ status: 409 });
      expect(sibling.ledger.calls).toHaveLength(0);
    });

    it('does not let one payout reference close two refunds', async () => {
      const { service, ledger } = setup({
        referenceHolder: defaultRefundRequest({ id: 'refund-9', status: RefundRequestStatus.COMPLETED, refund_reference: 'REF-1' }),
      });
      await expect(service.completeManually('admin-1', 'refund-1', 'REF-1')).rejects.toMatchObject({ status: 409 });
      expect(ledger.calls).toHaveLength(0);
    });

    it('records the shortfall in full when the earning had already been paid out', async () => {
      const { service, balance } = setup({ earning: defaultEarning({ status: InstructorEarningStatus.PAID_OUT }) });
      await service.completeManually('admin-1', 'refund-1', 'REF-1');
      expect(balance.recordShortfall).toHaveBeenCalledWith(expect.anything(), 'instructor-1', 3500, 'EGP', 'refund-1');
    });
  });
});
