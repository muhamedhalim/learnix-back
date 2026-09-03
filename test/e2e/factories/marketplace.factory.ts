import { randomBytes, randomInt } from 'node:crypto';

import {
  InstructorApplicationStatus,
  InstructorEarningStatus,
  MarketplaceCommissionScope,
  MarketplaceEnrollmentStatus,
  MarketplaceInstructorStatus,
  MarketplaceLedgerDirection,
  MarketplaceLedgerEntryType,
  MarketplaceOrderStatus,
  PayoutRequestStatus,
} from '../../../src/marketplace/common/enums';

function suffix(): string {
  return `${Date.now()}-${randomBytes(4).toString('hex')}`;
}

/** Row shape for `marketplace_instructors` (data-model.md §1). Not yet persisted — callers insert or save it. */
export interface MarketplaceInstructorFixture {
  user_id: string;
  application_id: string | null;
  status: MarketplaceInstructorStatus;
  slug: string;
  display_name: string;
  years_of_experience: number;
  approved_by: string;
  /** Only meaningful (and, by `CHK_mp_instructors_suspension_reason`, mandatory) when `status` is `suspended`. */
  suspension_reason?: string;
}

export function buildInstructorFixture(
  overrides: Partial<MarketplaceInstructorFixture> = {},
): MarketplaceInstructorFixture {
  const id = suffix();
  return {
    user_id: overrides.user_id ?? '',
    application_id: null,
    status: MarketplaceInstructorStatus.APPROVED,
    slug: `instructor-${id}`,
    display_name: `Test Instructor ${id}`,
    years_of_experience: randomInt(1, 20),
    approved_by: overrides.user_id ?? '',
    ...overrides,
  };
}

/** Row shape for `marketplace_instructor_applications` (data-model.md §1). */
export interface MarketplaceApplicationFixture {
  user_id: string;
  status: InstructorApplicationStatus;
  display_name: string;
  years_of_experience: number;
}

export function buildApplicationFixture(
  overrides: Partial<MarketplaceApplicationFixture> = {},
): MarketplaceApplicationFixture {
  return {
    user_id: overrides.user_id ?? '',
    status: InstructorApplicationStatus.SUBMITTED,
    display_name: `Test Applicant ${suffix()}`,
    years_of_experience: randomInt(1, 20),
    ...overrides,
  };
}

/** Row shape for `marketplace_courses` (data-model.md §2). */
export interface MarketplaceCourseFixture {
  instructor_id: string;
  category_id: string;
  slug: string;
  title: string;
  summary: string;
  description: string;
  level: string;
  language: string;
  price_minor: number;
  currency: string;
  cover_image_key: string;
}

export function buildCourseFixture(overrides: Partial<MarketplaceCourseFixture> = {}): MarketplaceCourseFixture {
  const id = suffix();
  return {
    instructor_id: overrides.instructor_id ?? '',
    category_id: overrides.category_id ?? '',
    slug: `course-${id}`,
    title: `Test Course ${id}`,
    summary: 'A test course summary',
    description: 'A test course description',
    level: 'beginner',
    language: 'en',
    price_minor: 10_000,
    currency: 'EGP',
    cover_image_key: `covers/${id}.jpg`,
    ...overrides,
  };
}

/** Row shape for `marketplace_orders` (data-model.md §3). Commission/split fields must reconcile exactly (CHK_mp_orders_split). */
export interface MarketplaceOrderFixture {
  order_number: string;
  learner_id: string;
  course_id: string;
  course_version_id: string;
  instructor_id: string;
  gross_amount_minor: number;
  discount_amount_minor: number;
  net_amount_minor: number;
  currency: string;
  commission_bps: number;
  commission_scope: MarketplaceCommissionScope;
  commission_amount_minor: number;
  instructor_earning_minor: number;
  refund_window_days: number;
  consumption_cap_bps: number;
  status: MarketplaceOrderStatus;
  is_zero_value: boolean;
  course_title_snapshot: string;
  instructor_name_snapshot: string;
}

/** Defaults to a 1000-minor-unit sale at 30% commission (300/700 split) — change amounts together to keep CHK_mp_orders_split satisfied. */
export function buildOrderFixture(overrides: Partial<MarketplaceOrderFixture> = {}): MarketplaceOrderFixture {
  return {
    order_number: `MP-${suffix()}`,
    learner_id: overrides.learner_id ?? '',
    course_id: overrides.course_id ?? '',
    course_version_id: overrides.course_version_id ?? '',
    instructor_id: overrides.instructor_id ?? '',
    gross_amount_minor: 1000,
    discount_amount_minor: 0,
    net_amount_minor: 1000,
    currency: 'EGP',
    commission_bps: 3000,
    commission_scope: MarketplaceCommissionScope.PLATFORM,
    commission_amount_minor: 300,
    instructor_earning_minor: 700,
    refund_window_days: 14,
    consumption_cap_bps: 3000,
    status: MarketplaceOrderStatus.PAID,
    is_zero_value: false,
    course_title_snapshot: 'Test Course',
    instructor_name_snapshot: 'Test Instructor',
    ...overrides,
  };
}

/** Row shape for `marketplace_enrollments` (data-model.md §3). */
export interface MarketplaceEnrollmentFixture {
  learner_id: string;
  course_id: string;
  course_version_id: string;
  order_id: string;
  status: MarketplaceEnrollmentStatus;
  progress_bps: number;
}

export function buildEnrollmentFixture(
  overrides: Partial<MarketplaceEnrollmentFixture> = {},
): MarketplaceEnrollmentFixture {
  return {
    learner_id: overrides.learner_id ?? '',
    course_id: overrides.course_id ?? '',
    course_version_id: overrides.course_version_id ?? '',
    order_id: overrides.order_id ?? '',
    status: MarketplaceEnrollmentStatus.ACTIVE,
    progress_bps: 0,
    ...overrides,
  };
}

/** Row shape for `marketplace_instructor_earnings` (data-model.md §4). gross = commission + net (CHK_mp_earnings_split). */
export interface MarketplaceEarningFixture {
  instructor_id: string;
  order_id: string;
  gross_amount_minor: number;
  commission_amount_minor: number;
  net_amount_minor: number;
  currency: string;
  commission_bps: number;
  status: InstructorEarningStatus;
  available_at: Date;
}

export function buildEarningFixture(overrides: Partial<MarketplaceEarningFixture> = {}): MarketplaceEarningFixture {
  return {
    instructor_id: overrides.instructor_id ?? '',
    order_id: overrides.order_id ?? '',
    gross_amount_minor: 1000,
    commission_amount_minor: 300,
    net_amount_minor: 700,
    currency: 'EGP',
    commission_bps: 3000,
    status: InstructorEarningStatus.PENDING_EARNINGS,
    available_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

/** Row shape for `marketplace_ledger_entries` (data-model.md §4). `reference` must be unique — pass one via LedgerService.buildReference in real usage. */
export interface MarketplaceLedgerEntryFixture {
  instructor_id: string;
  order_id: string | null;
  entry_type: MarketplaceLedgerEntryType;
  amount_minor: number;
  currency: string;
  direction: MarketplaceLedgerDirection;
  reference: string;
  created_by: string | null;
  metadata: Record<string, unknown>;
}

export function buildLedgerEntryFixture(
  overrides: Partial<MarketplaceLedgerEntryFixture> = {},
): MarketplaceLedgerEntryFixture {
  return {
    instructor_id: overrides.instructor_id ?? '',
    order_id: overrides.order_id ?? null,
    entry_type: MarketplaceLedgerEntryType.COURSE_SALE,
    amount_minor: 700,
    currency: 'EGP',
    direction: MarketplaceLedgerDirection.CREDIT,
    reference: `${MarketplaceLedgerEntryType.COURSE_SALE}:${suffix()}`,
    created_by: null,
    metadata: {},
    ...overrides,
  };
}

/** Row shape for `marketplace_payout_requests` (data-model.md §4). */
export interface MarketplacePayoutRequestFixture {
  request_number: string;
  instructor_id: string;
  payout_account_id: string;
  amount_minor: number;
  currency: string;
  status: PayoutRequestStatus;
  idempotency_key: string;
}

export function buildPayoutRequestFixture(
  overrides: Partial<MarketplacePayoutRequestFixture> = {},
): MarketplacePayoutRequestFixture {
  const id = suffix();
  return {
    request_number: `MPPO-${id}`,
    instructor_id: overrides.instructor_id ?? '',
    payout_account_id: overrides.payout_account_id ?? '',
    amount_minor: 50_000,
    currency: 'EGP',
    status: PayoutRequestStatus.REQUESTED,
    idempotency_key: `payout-request:${id}`,
    ...overrides,
  };
}
