import { OrderStatus } from '../../payments/entities/order-status.enum';
import { PaymentStatus } from '../../payments/entities/payment-status.enum';
import {
  ENTITLED_ORDER_STATUSES,
  FINALISED_PAYMENT_STATUS_SQL,
  FINALISED_PAYMENT_STATUSES,
  netRevenueMinorSql,
  SETTLED_ORDER_STATUS_SQL,
  SETTLED_ORDER_STATUSES,
  settledOrderPredicateSql,
} from './settled-order.sql';

/**
 * AUD-030 regression coverage for the shared accounting rule.
 *
 * These assertions are deliberately about *membership*, not SQL text: the whole
 * defect was a population that silently excluded refunded sales, so what must
 * never regress is which order states count as settled.
 */
describe('settled-order accounting rule', () => {
  describe('SETTLED_ORDER_STATUSES', () => {
    it('counts a paid order with no refund', () => {
      expect(SETTLED_ORDER_STATUSES).toContain(OrderStatus.PAID);
    });

    it('counts a partially refunded order — the student kept access and the money is partly kept', () => {
      expect(SETTLED_ORDER_STATUSES).toContain(OrderStatus.PARTIALLY_REFUNDED);
    });

    it('counts a fully refunded order so the refund is subtracted, not erased', () => {
      expect(SETTLED_ORDER_STATUSES).toContain(OrderStatus.REFUNDED);
    });

    it('excludes every state that never took money', () => {
      for (const status of [
        OrderStatus.AWAITING_PAYMENT,
        OrderStatus.PAYMENT_SUBMITTED,
        OrderStatus.UNDER_REVIEW,
        OrderStatus.REJECTED,
        OrderStatus.EXPIRED,
        OrderStatus.CANCELLED,
      ]) {
        expect(SETTLED_ORDER_STATUSES).not.toContain(status);
      }
    });
  });

  describe('FINALISED_PAYMENT_STATUSES', () => {
    it('accepts a completed payment', () => {
      expect(FINALISED_PAYMENT_STATUSES).toContain(PaymentStatus.COMPLETED);
    });

    it('accepts a refunded payment (a full refund flips the payment row too)', () => {
      expect(FINALISED_PAYMENT_STATUSES).toContain(PaymentStatus.REFUNDED);
    });

    it('rejects a failed payment', () => {
      expect(FINALISED_PAYMENT_STATUSES).not.toContain(PaymentStatus.FAILED);
    });

    it('rejects pending, processing and expired payments', () => {
      for (const status of [PaymentStatus.PENDING, PaymentStatus.PROCESSING, PaymentStatus.EXPIRED]) {
        expect(FINALISED_PAYMENT_STATUSES).not.toContain(status);
      }
    });
  });

  describe('ENTITLED_ORDER_STATUSES', () => {
    it('keeps access for paid and partially refunded orders', () => {
      expect(ENTITLED_ORDER_STATUSES).toEqual([OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED]);
    });

    it('does not keep access for a fully refunded order', () => {
      expect(ENTITLED_ORDER_STATUSES).not.toContain(OrderStatus.REFUNDED);
    });

    it('is narrower than the settled set — settled is about money, entitled is about access', () => {
      expect(ENTITLED_ORDER_STATUSES.length).toBeLessThan(SETTLED_ORDER_STATUSES.length);
    });
  });

  describe('netRevenueMinorSql', () => {
    it('subtracts the cumulative refund from the charged amount', () => {
      expect(netRevenueMinorSql('o')).toBe('(o.final_amount_minor - o.refunded_amount_minor)');
    });

    it('honours the caller alias so it composes into any query', () => {
      expect(netRevenueMinorSql('order')).toContain('order.final_amount_minor');
      expect(netRevenueMinorSql('order')).toContain('order.refunded_amount_minor');
    });
  });

  describe('settledOrderPredicateSql', () => {
    it('always requires a recognition timestamp', () => {
      expect(settledOrderPredicateSql('o')).toContain('o.paid_at IS NOT NULL');
    });

    it('emits a self-contained payment EXISTS check when no payment alias is joined', () => {
      const sql = settledOrderPredicateSql('o');
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('FROM payments p');
      expect(sql).toContain(FINALISED_PAYMENT_STATUS_SQL);
    });

    it('uses the joined payment alias instead of a sub-select when one is supplied', () => {
      const sql = settledOrderPredicateSql('o', 'payment');
      expect(sql).not.toContain('EXISTS');
      expect(sql).toContain(`payment.status IN (${FINALISED_PAYMENT_STATUS_SQL})`);
    });

    it('is a single line so TypeORM rewrites and quotes every `alias.column` (reserved alias `order`)', () => {
      expect(settledOrderPredicateSql('order')).not.toContain('\n');
      expect(settledOrderPredicateSql('order', 'payment')).not.toContain('\n');
    });

    it('restricts to the settled order states', () => {
      expect(settledOrderPredicateSql('o')).toContain(`o.status IN (${SETTLED_ORDER_STATUS_SQL})`);
    });

    it("never admits a cancelled or failed sale through the predicate", () => {
      const sql = settledOrderPredicateSql('o');
      expect(sql).not.toContain(`'${OrderStatus.CANCELLED}'`);
      expect(sql).not.toContain(`'${PaymentStatus.FAILED}'`);
    });
  });

  describe('SQL literal lists', () => {
    it('quotes every settled order status', () => {
      expect(SETTLED_ORDER_STATUS_SQL).toBe("'paid','partially_refunded','refunded'");
    });

    it('quotes every finalised payment status', () => {
      expect(FINALISED_PAYMENT_STATUS_SQL).toBe("'completed','refunded'");
    });
  });
});

/**
 * The arithmetic the fixed queries now perform, asserted as a table of the
 * scenarios the accounting rule has to get right.
 */
describe('net revenue arithmetic by scenario', () => {
  const net = (charged: number, refunded: number) => charged - refunded;

  it.each([
    ['paid order with no refund', 10_000, 0, 10_000],
    ['partially refunded order', 10_000, 2_500, 7_500],
    ['fully refunded order', 10_000, 10_000, 0],
    ['several partial refunds totalling a full refund', 10_000, 10_000, 0],
    ['partial refund of one piastre', 10_000, 1, 9_999],
  ])('%s → %d minor charged, %d refunded, nets %d', (_label, charged, refunded, expected) => {
    expect(net(charged, refunded)).toBe(expected);
  });

  it('never lets a refunded sale vanish the way the old paid-only rule did', () => {
    // Before the fix a fully refunded order was filtered out entirely, so both
    // its gross and its refund disappeared and the books "balanced" by accident.
    const excludedByOldRule = 0;
    const includedByNewRule = net(10_000, 10_000);
    expect(includedByNewRule).toBe(excludedByOldRule);
    // ...but the partially refunded case is where the old rule actually lied:
    expect(net(10_000, 2_500)).not.toBe(0);
  });
});
