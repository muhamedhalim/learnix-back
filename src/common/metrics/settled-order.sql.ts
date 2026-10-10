import { OrderStatus } from '../../payments/entities/order-status.enum';
import { PaymentStatus } from '../../payments/entities/payment-status.enum';

/**
 * The one definition of "this order settled", shared by every financial read.
 *
 * ## The rule
 * An order counts as settled when it reached a paid terminal state, carries a
 * real recognition timestamp, and has a finalised payment behind it. A refund
 * does **not** un-settle a sale: it stays in the population and is *subtracted*,
 * because "we sold this and gave some of it back" and "we never sold it" are
 * different facts and only one of them is true.
 *
 * ## Why this file exists (AUD-030)
 * `ProductFinancialMetricsService` already encoded this rule, but three other
 * services had each re-derived a narrower one — `status = 'paid'` alone. That
 * silently dropped every refunded sale from reporting instead of netting it:
 *
 *   - a **fully refunded** order (`status = 'refunded'`) vanished from both
 *     gross sales *and* the refund total, so the report balanced only because
 *     both sides disappeared together;
 *   - a **partially refunded** order (`status = 'partially_refunded'`) vanished
 *     entirely even though the student kept access and the platform kept most
 *     of the money — real, retained revenue simply stopped being counted.
 *
 * Duplicating the predicate is what allowed the two definitions to drift, so it
 * now lives in exactly one place that all four call sites import.
 *
 * @see RefundsService.completeRefund for the transitions this mirrors:
 *      partial → order `partially_refunded`, payment stays `completed`;
 *      full → order `refunded`, payment `refunded`.
 */
export const SETTLED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PARTIALLY_REFUNDED,
  OrderStatus.REFUNDED,
];

/**
 * Order states whose entitlement must still be active.
 *
 * A partial refund deliberately leaves access in place
 * (`entitlement_policy: retained_on_partial_refund`); a full refund revokes it.
 * Reconciliation checks that ask "should this order hold access?" use this set,
 * which is why it is narrower than {@link SETTLED_ORDER_STATUSES}.
 */
export const ENTITLED_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PARTIALLY_REFUNDED,
];

/** Payment states that represent money actually captured (refund included). */
export const FINALISED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.COMPLETED,
  PaymentStatus.REFUNDED,
];

/** SQL literal list, e.g. `'paid','partially_refunded','refunded'`. */
function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

export const SETTLED_ORDER_STATUS_SQL = quoteList(SETTLED_ORDER_STATUSES);
export const FINALISED_PAYMENT_STATUS_SQL = quoteList(FINALISED_PAYMENT_STATUSES);

/**
 * Net revenue for an order in minor units: charged minus refunded.
 *
 * This is the figure any surface labelled simply "revenue" must use. Gross
 * (`final_amount_minor` alone) and refunds are both legitimate to report, but
 * only ever *alongside* net and clearly labelled — never as "revenue".
 *
 * @param alias table alias for `orders` in the calling query
 */
export function netRevenueMinorSql(alias: string): string {
  return `(${alias}.final_amount_minor - ${alias}.refunded_amount_minor)`;
}

/**
 * The settled-order predicate as a SQL fragment, for raw/CTE queries.
 *
 * @param alias table alias for `orders`
 * @param paymentAlias when the caller already joined `payments`, its alias;
 *        omit to emit a self-contained `EXISTS` sub-select instead.
 */
export function settledOrderPredicateSql(alias: string, paymentAlias?: string): string {
  // Kept on ONE line: when this fragment is used inside a TypeORM query builder, `alias.column`
  // property paths are only rewritten (and quoted) if followed by a space, `)`, `,` or `=`.
  // A line break right after `order.payment_id` left it unquoted and `order` is a reserved word.
  const paymentCondition =
    paymentAlias === undefined
      ? `EXISTS (SELECT 1 FROM payments p WHERE p.id = ${alias}.payment_id AND p.status IN (${FINALISED_PAYMENT_STATUS_SQL}))`
      : `${paymentAlias}.status IN (${FINALISED_PAYMENT_STATUS_SQL})`;

  return `${alias}.paid_at IS NOT NULL AND ${alias}.status IN (${SETTLED_ORDER_STATUS_SQL}) AND ${paymentCondition}`;
}
