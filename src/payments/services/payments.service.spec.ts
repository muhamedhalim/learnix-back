import { NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { LessonSessionsService } from '../../lessons/lesson-sessions.service';
import { BookPurchase } from '../../books/entities/book-purchase.entity';
import {
  ItemType,
  LessonPurchase,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentStatus,
} from '../entities';
import { EntitlementsService } from './entitlements.service';
import { CartCheckoutService } from './cart-checkout.service';
import { OrdersService } from './orders.service';
import { PaymentFinalizationService } from './payment-finalization.service';
import { PaymentsService } from './payments.service';
import { RefundsService } from './refunds.service';

describe('PaymentsService — canonical compatibility routes', () => {
  let service: PaymentsService;
  let payments: { findOne: jest.Mock };
  let orders: {
    createOrder: jest.Mock;
    startGatewayCheckout: jest.Mock;
    createReopenOrder: jest.Mock;
  };
  let finalizer: { finalizeSuccessfulPayment: jest.Mock };
  let refunds: { completeProviderNotification: jest.Mock };
  let discounts: { releaseUsageForPayment: jest.Mock };
  let entitlements: { getActive: jest.Mock; hasItemAccess: jest.Mock };
  let lessonPurchases: { findOne: jest.Mock };
  let packagePurchases: { findOne: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };

  const payment = (over: Partial<Payment> = {}): Payment =>
    ({
      id: 'payment-1',
      order_id: 'order-1',
      user_id: 'student-1',
      item_type: ItemType.LESSON,
      item_id: 'lesson-1',
      status: PaymentStatus.PROCESSING,
      provider_reference: 'provider-1',
      amount_minor: 10_000,
      currency: 'EGP',
      ...over,
    }) as Payment;

  beforeEach(async () => {
    payments = { findOne: jest.fn() };
    orders = {
      createOrder: jest.fn(),
      startGatewayCheckout: jest.fn(),
      createReopenOrder: jest.fn(),
    };
    finalizer = { finalizeSuccessfulPayment: jest.fn().mockResolvedValue(undefined) };
    refunds = { completeProviderNotification: jest.fn().mockResolvedValue(undefined) };
    discounts = { releaseUsageForPayment: jest.fn().mockResolvedValue(undefined) };
    entitlements = {
      getActive: jest.fn().mockResolvedValue(null),
      hasItemAccess: jest.fn().mockResolvedValue(false),
    };
    lessonPurchases = { findOne: jest.fn().mockResolvedValue(null) };
    packagePurchases = { findOne: jest.fn().mockResolvedValue(null) };
    manager = {
      findOne: jest.fn(),
      save: jest.fn((_entity: unknown, value: unknown) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const dataSource = {
      transaction: jest.fn((a: unknown, b: unknown) => {
        const fn = (typeof a === 'function' ? a : b) as (m: typeof manager) => unknown;
        return fn(manager);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: payments },
        { provide: getRepositoryToken(LessonPurchase), useValue: lessonPurchases },
        { provide: getRepositoryToken(PackagePurchase), useValue: packagePurchases },
        { provide: getRepositoryToken(BookPurchase), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: DiscountCodesService, useValue: discounts },
        { provide: OrdersService, useValue: orders },
        { provide: PaymentFinalizationService, useValue: finalizer },
        {
          provide: EntitlementsService,
          useValue: entitlements,
        },
        { provide: RefundsService, useValue: refunds },
        { provide: LessonSessionsService, useValue: { markForOrder: jest.fn() } },
        {
          provide: CartCheckoutService,
          useValue: {
            finalizeSuccessfulGatewayPayment: jest.fn(),
            completeProviderRefundNotification: jest.fn(),
            failGatewayPayment: jest.fn().mockResolvedValue(false),
          },
        },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  it('routes the legacy lesson checkout endpoint through a canonical order', async () => {
    orders.createOrder.mockResolvedValue({
      order: {
        id: 'order-1',
        original_amount_minor: 10_000,
        discount_amount_minor: 1_000,
        final_amount_minor: 9_000,
      },
    });
    orders.startGatewayCheckout.mockResolvedValue({
      payment_id: 'payment-1',
      redirect_url: 'https://gateway.example/checkout',
    });

    const result = await service.purchaseLesson(
      {
        lesson_id: 'lesson-1',
        discount_code: 'SAVE10',
        idempotency_key: 'request-1',
        billing_data: {},
      } as never,
      'student-1',
    );

    expect(orders.createOrder).toHaveBeenCalledWith(
      {
        item_type: ItemType.LESSON,
        item_id: 'lesson-1',
        payment_channel: 'gateway',
        discount_code: 'SAVE10',
        idempotency_key: 'request-1',
      },
      'student-1',
    );
    expect(orders.startGatewayCheckout).toHaveBeenCalledWith('order-1', 'student-1', {
      billing_data: {},
    });
    expect(result).toMatchObject({
      payment_id: 'payment-1',
      final_amount: 90,
      iframe_url: 'https://gateway.example/checkout',
    });
  });

  it('delegates verified success exclusively to the shared finalizer', async () => {
    payments.findOne.mockResolvedValue(payment());

    await service.processSuccessfulPayment('payment-1', {
      amountCents: 10_000,
      currency: 'EGP',
      transactionId: 'transaction-1',
    });

    expect(finalizer.finalizeSuccessfulPayment).toHaveBeenCalledWith({
      orderId: 'order-1',
      paymentId: 'payment-1',
      sourceReference: 'transaction-1',
      actorId: null,
      verifiedAmountMinor: 10_000,
      verifiedCurrency: 'EGP',
    });
  });

  it('fails closed when a payment has no canonical order', async () => {
    payments.findOne.mockResolvedValue(payment({ order_id: null }));

    await expect(service.processSuccessfulPayment('payment-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(finalizer.finalizeSuccessfulPayment).not.toHaveBeenCalled();
  });

  it('delegates provider refunds to the canonical refund workflow', async () => {
    payments.findOne.mockResolvedValue(payment());

    await service.processRefundedPayment('payment-1', {
      amountCents: 10_000,
      currency: 'EGP',
      transactionId: 'refund-1',
    });

    expect(refunds.completeProviderNotification).toHaveBeenCalledWith(
      'payment-1',
      'refund-1',
      10_000,
      'EGP',
    );
  });

  it('uses the canonical entitlement policy for package and lesson access', async () => {
    // T074: one entitlement probe. An active entitlement is found by `getActive` itself (it applies
    // the same predicate the removed second probe did), so the answer is unchanged.
    entitlements.getActive.mockResolvedValue({ expires_at: null });

    await expect(
      service.checkItemAccess('student-1', ItemType.PACKAGE, 'package-1'),
    ).resolves.toEqual({ has_access: true });
    await expect(service.checkLessonAccess('student-1', 'lesson-1')).resolves.toEqual({
      has_access: true,
    });

    expect(entitlements.getActive).toHaveBeenCalledWith('student-1', ItemType.PACKAGE, 'package-1');
    expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
  });

  describe('checkItemAccess single entitlement probe (T074 / W4-C9)', () => {
    const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000);

    it('active entitlement without expiry: one probe, no purchase reads', async () => {
      entitlements.getActive.mockResolvedValue({ expires_at: null });

      await expect(service.checkItemAccess('s', ItemType.LESSON, 'l')).resolves.toEqual({ has_access: true });

      expect(entitlements.getActive).toHaveBeenCalledTimes(1);
      expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
      expect(lessonPurchases.findOne).not.toHaveBeenCalled();
    });

    it('active entitlement with an expiry reports the remaining days', async () => {
      const expiresAt = daysFromNow(3);
      entitlements.getActive.mockResolvedValue({ expires_at: expiresAt });

      await expect(service.checkItemAccess('s', ItemType.LESSON, 'l')).resolves.toEqual({
        has_access: true,
        expires_at: expiresAt,
        days_remaining: 3,
      });
      expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
    });

    it('expired or revoked entitlement (getActive finds nothing) falls back to exactly one purchase read, never a second entitlement read', async () => {
      entitlements.getActive.mockResolvedValue(null);
      lessonPurchases.findOne.mockResolvedValue(null);

      await expect(service.checkItemAccess('s', ItemType.LESSON, 'l')).resolves.toEqual({ has_access: false });

      expect(entitlements.getActive).toHaveBeenCalledTimes(1);
      expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
      expect(lessonPurchases.findOne).toHaveBeenCalledTimes(1);
    });

    it('package fallback: a live, unrevoked package purchase grants access; none does not', async () => {
      entitlements.getActive.mockResolvedValue(null);
      packagePurchases.findOne.mockResolvedValueOnce({ id: 'pp' }).mockResolvedValueOnce(null);

      await expect(service.checkItemAccess('s', ItemType.PACKAGE, 'p')).resolves.toEqual({ has_access: true });
      await expect(service.checkItemAccess('s', ItemType.PACKAGE, 'p')).resolves.toEqual({ has_access: false });

      expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
      expect(lessonPurchases.findOne).not.toHaveBeenCalled();
    });

    it('book fallback: a live book purchase grants access; none does not', async () => {
      const bookPurchases = { findOne: jest.fn().mockResolvedValueOnce({ id: 'bp' }).mockResolvedValueOnce(null) };
      (service as unknown as { bookPurchasesRepository: unknown }).bookPurchasesRepository = bookPurchases;
      entitlements.getActive.mockResolvedValue(null);

      await expect(service.checkItemAccess('s', ItemType.BOOK, 'b')).resolves.toEqual({ has_access: true });
      await expect(service.checkItemAccess('s', ItemType.BOOK, 'b')).resolves.toEqual({ has_access: false });

      expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
      expect(bookPurchases.findOne).toHaveBeenCalledTimes(2);
    });

    it('lesson legacy fallback: an unexpired purchase grants access with its expiry and remaining days', async () => {
      const expiresAt = daysFromNow(10);
      entitlements.getActive.mockResolvedValue(null);
      lessonPurchases.findOne.mockResolvedValue({ access_expires_at: expiresAt });

      await expect(service.checkItemAccess('s', ItemType.LESSON, 'l')).resolves.toEqual({
        has_access: true,
        expires_at: expiresAt,
        days_remaining: 10,
      });
      expect(entitlements.hasItemAccess).not.toHaveBeenCalled();
    });

    it('a single-lesson playback gate still consults the entitlement predicate itself (unchanged)', async () => {
      entitlements.hasItemAccess.mockResolvedValue(true);

      await expect(service.hasLessonPlaybackAccess('s', 'l')).resolves.toBe(true);

      expect(entitlements.hasItemAccess).toHaveBeenCalledWith('s', ItemType.LESSON, 'l');
    });
  });

  it('does not let permanent package ownership bypass an expired package lesson', async () => {
    entitlements.getActive.mockResolvedValue(null);
    entitlements.hasItemAccess.mockResolvedValue(false);
    lessonPurchases.findOne.mockResolvedValue(null);

    await expect(service.checkLessonAccess('student-1', 'expired-lesson')).resolves.toEqual({
      has_access: false,
    });
    await expect(service.hasLessonPlaybackAccess('student-1', 'expired-lesson')).resolves.toBe(false);

    expect(packagePurchases.findOne).not.toHaveBeenCalled();
    expect(lessonPurchases.findOne).toHaveBeenCalledTimes(2);
  });

  it('keeps another lesson in the same package accessible through its active lesson purchase', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    lessonPurchases.findOne.mockResolvedValue({ access_expires_at: expiresAt });

    await expect(service.checkLessonAccess('student-1', 'active-lesson')).resolves.toEqual(
      expect.objectContaining({ has_access: true, expires_at: expiresAt }),
    );
    await expect(service.hasLessonPlaybackAccess('student-1', 'active-lesson')).resolves.toBe(true);
  });

  describe('getPlaybackAccessibleLessonIds (T065 batched playback filter)', () => {
    const queryMock = (): jest.Mock => {
      const mock = jest.fn();
      (service as unknown as { dataSource: { query: jest.Mock } }).dataSource.query = mock;
      return mock;
    };

    it('returns an empty set without querying when there are no lesson ids', async () => {
      const query = queryMock();

      await expect(service.getPlaybackAccessibleLessonIds('student-1', [])).resolves.toEqual(new Set());
      expect(query).not.toHaveBeenCalled();
    });

    it('runs one statement with one array bind and returns the accessible ids', async () => {
      const query = queryMock().mockResolvedValue([{ lesson_id: 'l-2' }, { lesson_id: 'l-3' }]);

      const result = await service.getPlaybackAccessibleLessonIds('student-1', ['l-1', 'l-2', 'l-2', 'l-3']);

      expect(result).toEqual(new Set(['l-2', 'l-3']));
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['student-1', ['l-1', 'l-2', 'l-3'], ItemType.LESSON, 'active']);
      expect(sql).toContain('ANY($2::uuid[])');
    });

    it('keeps the access rules narrow: UNION of two live branches, database clock, no preview or package branch', async () => {
      const query = queryMock().mockResolvedValue([]);

      await service.getPlaybackAccessibleLessonIds('student-1', ['l-1']);

      const sql = (query.mock.calls[0] as [string])[0];
      expect(sql.split('UNION')).toHaveLength(2);
      expect(sql).not.toContain('UNION ALL');
      expect(sql).toContain('e.status = $4');
      expect(sql).toContain('(e.expires_at IS NULL OR e.expires_at > NOW())');
      expect(sql).toContain('p.revoked_at IS NULL');
      expect(sql).toContain('p.access_expires_at > NOW()');
      for (const forbidden of ['is_free_preview', 'package_purchases', 'e.revoked_at']) {
        expect(sql).not.toContain(forbidden);
      }
    });
  });

  it('closes the active order and releases discounts after a verified failure', async () => {
    manager.findOne.mockResolvedValue(payment());

    await service.processFailedPayment('payment-1', 'declined', {
      amountCents: 0,
      currency: 'EGP',
      transactionId: 'failure-1',
    });

    expect(manager.save).toHaveBeenCalledWith(
      Payment,
      expect.objectContaining({
        status: PaymentStatus.FAILED,
        failure_reason: 'declined',
        paymob_transaction_id: 'failure-1',
      }),
    );
    expect(manager.update).toHaveBeenCalledWith(Order, expect.objectContaining({ id: 'order-1' }), {
      status: OrderStatus.REJECTED,
    });
    expect(discounts.releaseUsageForPayment).toHaveBeenCalledWith('payment-1', manager);
  });

  it('ignores a late failure after completion', async () => {
    manager.findOne.mockResolvedValue(payment({ status: PaymentStatus.COMPLETED }));

    await service.processFailedPayment('payment-1', 'late failure');

    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(discounts.releaseUsageForPayment).not.toHaveBeenCalled();
  });

  it('applies the requested date range and keeps revenue rankings currency-scoped', async () => {
    const query = {
      andWhere: jest.fn(),
      select: jest.fn(),
      groupBy: jest.fn(),
      addGroupBy: jest.fn(),
      orderBy: jest.fn(),
      getRawMany: jest
        .fn()
        .mockResolvedValueOnce([
          {
            lesson_id: 'lesson-1',
            lesson_title: 'Math',
            currency: 'EGP',
            purchase_count: '2',
            total_revenue: '150',
            avg_price: '75',
          },
        ])
        .mockResolvedValueOnce([
          {
            package_id: 'package-1',
            package_title: 'Algebra',
            currency: 'EGP',
            purchase_count: '1',
            total_revenue: '200',
            avg_price: '200',
          },
        ]),
    };
    for (const method of ['andWhere', 'select', 'groupBy', 'addGroupBy', 'orderBy'] as const) {
      query[method].mockReturnValue(query);
    }
    const baseQuery = jest.fn().mockReturnValue(query);
    (service as unknown as { getTeacherRevenueBaseQuery: jest.Mock }).getTeacherRevenueBaseQuery =
      baseQuery;

    await expect(
      service.getTeacherRevenueByLesson('teacher-a', '2026-01-01', '2026-01-31'),
    ).resolves.toMatchObject({
      lessons: [expect.objectContaining({ currency: 'EGP', total_revenue: 150 })],
    });
    await expect(
      service.getTeacherRevenueByPackage('teacher-a', '2026-01-01', '2026-01-31'),
    ).resolves.toMatchObject({
      packages: [expect.objectContaining({ currency: 'EGP', total_revenue: 200 })],
    });
    expect(baseQuery).toHaveBeenNthCalledWith(1, 'teacher-a', '2026-01-01', '2026-01-31');
    expect(baseQuery).toHaveBeenNthCalledWith(2, 'teacher-a', '2026-01-01', '2026-01-31');
    expect(query.addGroupBy).toHaveBeenCalledWith('order.currency');
  });
  describe('getMyPackages projection (T082) and per-course cardinality (T117)', () => {
    function mockQueryBuilder() {
      const qb: Record<string, jest.Mock> = {};
      for (const name of [
        'leftJoinAndSelect',
        'leftJoin',
        'addSelect',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
      ]) {
        qb[name] = jest.fn().mockReturnValue(qb);
      }
      qb['getMany'] = jest.fn().mockResolvedValue([{ id: 'pp' }]);
      return qb;
    }

    it('pages distinct courses, loads only that page by id (still student-scoped) and keeps the narrowed projection', async () => {
      const qb = mockQueryBuilder();
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ id: 'pp' }])
        .mockResolvedValueOnce([{ count: '41' }]);
      Object.assign(packagePurchases as unknown as Record<string, unknown>, {
        manager: { query },
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      });

      const result = await service.getMyPackages('student-1', 2, 20);

      expect(result.meta).toMatchObject({ total: 41, page: 2, limit: 20, totalPages: 3 });
      expect(result.data).toEqual([{ id: 'pp' }]);
      // Step 1: newest live purchase per course, offset/limit on purchase rows, scoped by student.
      const [pageSql, pageParams] = query.mock.calls[0] as [string, unknown[]];
      expect(pageSql).toContain('DISTINCT ON (package_id)');
      expect(pageSql).toContain('revoked_at IS NULL');
      expect(pageParams).toEqual(['student-1', 20, 20]);
      const [countSql, countParams] = query.mock.calls[1] as [string, unknown[]];
      expect(countSql).toContain('COUNT(DISTINCT package_id)');
      expect(countParams).toEqual(['student-1']);
      // Step 2: ids re-checked against the student; projection unchanged.
      expect(qb['where']).toHaveBeenCalledWith('purchase.id IN (:...ids)', { ids: ['pp'] });
      expect(qb['andWhere']).toHaveBeenCalledWith('purchase.student_id = :userId', {
        userId: 'student-1',
      });
      expect(qb['andWhere']).toHaveBeenCalledWith('purchase.revoked_at IS NULL');
      expect(qb['addSelect']).toHaveBeenCalledWith(['teacher.id', 'teacher.name', 'teacher.profile_picture_url']);
      // `title_ar` is not a lesson column; selecting it would make TypeORM throw.
      expect(qb['addSelect']).toHaveBeenCalledWith(['lesson.id', 'lesson.title', 'lesson.duration']);
      expect(qb['orderBy']).toHaveBeenCalledWith('purchase.purchased_at', 'DESC');
      expect(qb['addOrderBy']).toHaveBeenCalledWith('items.order_index', 'ASC');
    });

    it('skips the detail query when the student has no live purchases', async () => {
      const qb = mockQueryBuilder();
      const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '0' }]);
      const createQueryBuilder = jest.fn().mockReturnValue(qb);
      Object.assign(packagePurchases as unknown as Record<string, unknown>, {
        manager: { query },
        createQueryBuilder,
      });

      const result = await service.getMyPackages('student-1');

      expect(result).toMatchObject({ data: [], meta: { total: 0, totalPages: 0 } });
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });
  });

});
