/**
 * Canonical metric contracts shared by every Stats/Counts endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Before DEF-007 each product surface invented its own "revenue" and "students"
 * number — `price × students_count`, a hardcoded `0`, or a denormalised counter
 * nothing ever incremented. The rule from here on is: **one implementation per
 * metric definition**. If a number is defined here, it is produced by
 * {@link ProductFinancialMetricsService} or {@link LearningMetricsService} and
 * nowhere else. Do not re-derive any of these in a feature service.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MONEY REPRESENTATION
 * ─────────────────────────────────────────────────────────────────────────────
 * Every monetary field on these interfaces is in **minor units** (piastres for
 * EGP), matching `orders.*_minor` and the rest of the finance domain. Callers
 * that expose major units to an API convert explicitly at the boundary with
 * `fromMinorUnits`, so the conversion is always visible in the response mapper.
 */

/**
 * Financial totals for one product, in one currency.
 *
 * ## Population — "settled orders"
 * An order contributes to these totals when **all** of the following hold:
 *
 * - `orders.paid_at IS NOT NULL` — money was actually recognised, and this is
 *   the financial timestamp every other report keys on.
 * - `orders.status IN ('paid', 'partially_refunded', 'refunded')` — the order
 *   reached a paid terminal state. A later refund must not erase the sale from
 *   history; it is subtracted, not deleted.
 * - a linked `payments` row exists with `status IN ('completed', 'refunded')`
 *   — a real finalised payment backs the order. `PaymentFinalizationService`
 *   sets `completed`; `RefundsService` flips it to `refunded` on a full refund,
 *   so both are "this payment really settled".
 *
 * Consequently `awaiting_payment`, `payment_submitted`, `under_review`,
 * `rejected`, `expired` and `cancelled` orders contribute **nothing** to any
 * field below — not to revenue and not to any count.
 *
 * ## Divergence from the pre-existing report queries — deliberate
 * `ReportsService.paidOrderRevenueQuery`, `PaymentsService`'s
 * `canonicalPaidOrderRevenueQuery` and `PaymentOperationsService.paidOrdersCte`
 * all restrict to `status = 'paid'` alone. Because `RefundsService` moves a
 * refunded order to `partially_refunded`/`refunded`, those queries silently drop
 * a sale the moment any refund touches it — which is also why their own
 * `refunds_minor` / `net_revenue_minor` columns are structurally always zero /
 * equal to gross. The population above is the refund-aware superset; it is a
 * strict superset of `status = 'paid'`, so for refund-free data it produces
 * identical gross numbers.
 */
export interface CurrencyFinancialTotals {
  /** ISO-4217 code these totals are denominated in. */
  currency: string;

  /** Settled orders for this product. One order per purchase event. */
  order_count: number;

  /**
   * Settled orders that are not *fully* refunded (`status <> 'refunded'`).
   * Partially refunded orders still count — the student keeps access (see
   * `RefundsService`, `entitlement_policy: retained_on_partial_refund`).
   */
  active_order_count: number;

  /** `COUNT(DISTINCT student_id)` over settled orders. Repeat buyers count once. */
  unique_student_count: number;

  /**
   * `SUM(original_amount_minor)` — the catalogue/list price at checkout time,
   * before any discount. This is the only field that may be described as a
   * "list price" value; it is **not** money anybody paid.
   */
  list_price_value_minor: number;

  /** `SUM(discount_amount_minor)` — discount actually granted at checkout. */
  discount_amount_minor: number;

  /**
   * `SUM(final_amount_minor)` — what the student was actually charged, i.e.
   * list price minus discount. Refunds are **not** subtracted here.
   */
  gross_sales_minor: number;

  /** `SUM(refunded_amount_minor)` — cumulative refunded across all refunds. */
  refund_amount_minor: number;

  /**
   * `gross_sales_minor - refund_amount_minor` — money the platform actually
   * kept. This is the figure a dashboard labelled simply "revenue" must use.
   */
  net_revenue_minor: number;

  /**
   * Platform commission net of refund reversals. Reversal per order is
   * `FLOOR(platform_commission_minor * refunded_amount_minor / final_amount_minor)`
   * — byte-identical to the cumulative allocation `RefundsService.reverseLedger`
   * posts, so this agrees with the ledger for partial refunds too.
   */
  platform_commission_minor: number;

  /**
   * Teacher entitlement net of refund reversals. The teacher's reversal is the
   * refund remainder after commission (`refunded - commission_reversal`), again
   * matching `RefundsService.reverseLedger` exactly.
   */
  teacher_earnings_minor: number;
}

/**
 * Financial metrics for one product across every currency it ever sold in.
 *
 * Multi-currency is represented explicitly rather than silently summed: adding
 * piastres to cents would be a fabricated number. `primary` is the
 * highest-grossing currency and is what single-figure endpoints display.
 */
export interface ProductFinancialMetrics {
  /** Highest-grossing currency's totals. Zeroed (in EGP) when nothing sold. */
  primary: CurrencyFinancialTotals;
  /** Every currency with at least one settled order, highest gross first. */
  by_currency: CurrencyFinancialTotals[];
  /** True when settled orders span more than one currency. */
  mixed_currency: boolean;
}

/** Approved-review rating aggregate. `average` is null when there are none. */
export interface RatingMetrics {
  /** Mean of approved ratings, 2 dp. `null` means "no reviews", never 0 stars. */
  average: number | null;
  /** Number of approved reviews backing `average`. */
  count: number;
}

/**
 * Access/engagement metrics for one lesson.
 *
 * Access is read from `lesson_purchases`, which is the entitlement row
 * `PaymentFinalizationService` writes for a direct lesson sale **and** for every
 * lesson inside a purchased course. That makes it the only source that answers
 * "who can actually open this lesson".
 */
export interface LessonEngagementMetrics {
  /**
   * Unique students holding a non-revoked `lesson_purchases` row, whether the
   * lesson was bought on its own or as part of a course. Expired access still
   * counts — the student did buy it.
   */
  students_with_access: number;
  /** Subset of the above whose access has not expired (`access_expires_at > now()`). */
  students_with_active_access: number;
  /** Unique students who completed the lesson (`lesson_progress.completed`). */
  students_completed: number;
}

/** Access/engagement metrics for one course, aggregated over every version. */
export interface PackageEngagementMetrics {
  /**
   * Unique students holding a non-revoked `package_purchases` row for this
   * course, counted once no matter how many versions they bought
   * (`COUNT(DISTINCT student_id)`).
   */
  students_with_access: number;
  /** Non-revoked `package_purchases` rows — one per purchased version. */
  purchase_rows: number;
  /** Distinct `course_version_id`s that have at least one live purchase. */
  purchased_version_count: number;
}

/**
 * Learning metrics for one student, keyed on `users.id`.
 *
 * Averages are `null` when the underlying set is empty: an average of nothing
 * is not zero, and rendering "0%" for a student who has never sat an exam
 * misreports them as failing.
 */
export interface StudentLearningMetrics {
  /**
   * Distinct lessons the student holds non-revoked access to, from direct
   * lesson purchases and from lessons inside purchased courses alike.
   */
  lessons_purchased: number;
  /** Distinct lessons marked completed in `lesson_progress`. */
  lessons_completed: number;
  /** Distinct courses the student holds non-revoked access to. */
  courses_purchased: number;
  /** Exam attempts in the terminal `graded` state. */
  exams_completed: number;
  /**
   * Mean of `score_total / max_score * 100` over graded attempts with a
   * positive `max_score`, 2 dp. Percent — not raw points — so exams with
   * different totals are comparable. `null` when there is no such attempt.
   */
  average_score_percent: number | null;
}
