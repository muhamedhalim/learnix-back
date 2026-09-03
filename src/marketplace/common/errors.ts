import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { biBody } from '../../i18n/error-translator.util';

/**
 * Marketplace machine-readable error codes (contracts/README.md §7). Every
 * `422` for a readiness or refund-eligibility failure carries one of these
 * in its response body's `code` field, so a frontend never has to parse
 * English or Arabic prose to branch on the reason.
 */
export const MARKETPLACE_ERROR_CODES = {
  /** FR-109 — marketplace checkout takes no dependency on the academic discount system. */
  DISCOUNTS_NOT_APPLICABLE: 'DISCOUNTS_NOT_APPLICABLE',
  /** FR-119 — a zero-value order has nothing to refund. */
  NOTHING_TO_REFUND: 'NOTHING_TO_REFUND',
  /** FR-177, FR-179 — the 14-day window has closed (inclusive of its final instant). */
  REFUND_WINDOW_EXPIRED: 'REFUND_WINDOW_EXPIRED',
  /** FR-178, FR-179 — completion is at or above the 30.00% cap (exclusive). */
  REFUND_CONSUMPTION_EXCEEDED: 'REFUND_CONSUMPTION_EXCEEDED',
  /** FR-199 — an undecided refund request already exists for this order. */
  REFUND_ALREADY_OPEN: 'REFUND_ALREADY_OPEN',
  /** FR-055, FR-056 — the publication-readiness checklist has unmet items. */
  COURSE_NOT_READY_FOR_SUBMISSION: 'COURSE_NOT_READY_FOR_SUBMISSION',
  /** FR-011 — the mandatory application field set is incomplete. */
  APPLICATION_NOT_READY_FOR_SUBMISSION: 'APPLICATION_NOT_READY_FOR_SUBMISSION',
  /** FR-015 — the applicant already has an open (non-terminal) application. */
  APPLICATION_ALREADY_OPEN: 'APPLICATION_ALREADY_OPEN',
  /** FR-016 — resubmission is blocked by the 14-day wait or the 3-application cap. */
  APPLICATION_RESUBMISSION_BLOCKED: 'APPLICATION_RESUBMISSION_BLOCKED',
  /** FR-077, FR-281 — a requested page size exceeds the stated maximum. */
  PAGE_SIZE_EXCEEDS_MAXIMUM: 'PAGE_SIZE_EXCEEDS_MAXIMUM',
  /** contracts §7 — a money route requires an idempotency key. */
  IDEMPOTENCY_KEY_MISSING: 'IDEMPOTENCY_KEY_MISSING',
  /** contracts §7 — the same key was replayed with a different payload. */
  IDEMPOTENCY_KEY_CONFLICT: 'IDEMPOTENCY_KEY_CONFLICT',
  /** FR-303 — a signed asset URL is past its TTL or the requester has lost access. */
  SIGNED_URL_EXPIRED: 'SIGNED_URL_EXPIRED',
  /** FR-039 — a category with at least one referencing course cannot be deleted. */
  CATEGORY_REFERENCED: 'CATEGORY_REFERENCED',
  /** FR-036 — the taxonomy supports at most two levels; a sub-category cannot itself have a parent. */
  CATEGORY_DEPTH_EXCEEDED: 'CATEGORY_DEPTH_EXCEEDED',
  /** FR-049 — free-preview lessons cannot exceed `max(1, floor(proportion × lessons))`, capped. */
  COURSE_FREE_PREVIEW_BOUND_EXCEEDED: 'COURSE_FREE_PREVIEW_BOUND_EXCEEDED',
  /** FR-054 — an instructor cannot delete a course that has at least one enrollment; unpublish instead. */
  COURSE_HAS_ENROLLMENTS: 'COURSE_HAS_ENROLLMENTS',
  /** FR-063 — a submitted-for-review course is read-only to its instructor until an administrator decides. */
  COURSE_NOT_EDITABLE_UNDER_REVIEW: 'COURSE_NOT_EDITABLE_UNDER_REVIEW',
  /** FR-060 — the requested state transition is not one of the six permitted transitions. */
  COURSE_ILLEGAL_TRANSITION: 'COURSE_ILLEGAL_TRANSITION',
  /** FR-073 — a concurrent admin decision already resolved this course; this caller lost the race. */
  COURSE_ALREADY_DECIDED: 'COURSE_ALREADY_DECIDED',
  /** FR-103 — an order can only ever be created for a course that is currently `published`. */
  COURSE_NOT_PURCHASABLE: 'COURSE_NOT_PURCHASABLE',
  /** FR-098 — an instructor cannot buy their own course. */
  SELF_PURCHASE_NOT_ALLOWED: 'SELF_PURCHASE_NOT_ALLOWED',
  /** `UQ_mp_orders_open_per_course` — the learner already has an awaiting-payment or paid order for this course. */
  ORDER_ALREADY_OPEN: 'ORDER_ALREADY_OPEN',
  /** FR-121 — the free-enrollment rate limit (per-minute or per-day) was reached. */
  FREE_ENROLLMENT_RATE_LIMITED: 'FREE_ENROLLMENT_RATE_LIMITED',
  /** FR-111 — the free-enrollment endpoint only ever grants a genuinely zero-value course; a paid course must go through checkout. */
  COURSE_NOT_FREE: 'COURSE_NOT_FREE',
  /** FR-054a — a permanently removed course can never be republished or reopened for editing. */
  COURSE_PERMANENTLY_REMOVED: 'COURSE_PERMANENTLY_REMOVED',
  /** FR-255, `UQ_mp_reviews_learner_course` — a learner may hold at most one review per course. */
  REVIEW_ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  /** FR-209, FR-325 — below the currency's configured minimum payout amount. */
  PAYOUT_BELOW_MINIMUM: 'PAYOUT_BELOW_MINIMUM',
  /** FR-208 — the requested amount exceeds the instructor's current available balance in that currency. */
  PAYOUT_INSUFFICIENT_BALANCE: 'PAYOUT_INSUFFICIENT_BALANCE',
  /** FR-204 — a payout account referenced by an in-flight payout request cannot be removed. */
  PAYOUT_ACCOUNT_IN_USE: 'PAYOUT_ACCOUNT_IN_USE',
  /** FR-207 — the destination account's currency must match the requested payout currency. */
  PAYOUT_ACCOUNT_CURRENCY_MISMATCH: 'PAYOUT_ACCOUNT_CURRENCY_MISMATCH',
  /** FR-173 — a manual adjustment in a currency the instructor holds no earnings in at all. */
  ADJUSTMENT_CURRENCY_NOT_HELD: 'ADJUSTMENT_CURRENCY_NOT_HELD',
  /** FR-173 — a manual debit that would drive the available balance negative. */
  ADJUSTMENT_WOULD_GO_NEGATIVE: 'ADJUSTMENT_WOULD_GO_NEGATIVE',
} as const;

export type MarketplaceErrorCode =
  (typeof MARKETPLACE_ERROR_CODES)[keyof typeof MARKETPLACE_ERROR_CODES];

/**
 * `422` with a machine-readable `code`. The global `HttpExceptionFilter`
 * (reused, not reimplemented) already knows how to localise `biBody()`
 * messages and preserve extra body fields, so this just shapes the payload.
 */
export class MarketplaceUnprocessableException extends UnprocessableEntityException {
  constructor(
    code: MarketplaceErrorCode,
    messageEn: string,
    messageAr: string,
    details?: unknown[],
  ) {
    super({ code, ...biBody(messageEn, messageAr), ...(details ? { details } : {}) });
  }
}

export class MarketplaceConflictException extends ConflictException {
  constructor(code: MarketplaceErrorCode, messageEn: string, messageAr: string) {
    super({ code, ...biBody(messageEn, messageAr) });
  }
}

export class MarketplaceBadRequestException extends BadRequestException {
  constructor(code: MarketplaceErrorCode, messageEn: string, messageAr: string) {
    super({ code, ...biBody(messageEn, messageAr) });
  }
}

export class MarketplaceForbiddenException extends ForbiddenException {
  constructor(code: MarketplaceErrorCode, messageEn: string, messageAr: string) {
    super({ code, ...biBody(messageEn, messageAr) });
  }
}

export function discountsNotApplicable(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.DISCOUNTS_NOT_APPLICABLE,
    'Discount codes do not apply to marketplace courses',
    'أكواد الخصم لا تنطبق على الدورات الاحترافية',
  );
}

export function nothingToRefund(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.NOTHING_TO_REFUND,
    'There is nothing to refund for this order',
    'لا يوجد مبلغ لاسترداده لهذا الطلب',
  );
}

export function refundWindowExpired(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.REFUND_WINDOW_EXPIRED,
    'The refund window for this order has closed',
    'انتهت فترة استرداد هذا الطلب',
  );
}

export function refundConsumptionExceeded(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.REFUND_CONSUMPTION_EXCEEDED,
    'Too much of the course has been completed to qualify for a refund',
    'تم إكمال جزء كبير من الدورة بحيث لا يحق لك استرداد المبلغ',
  );
}

export function refundAlreadyOpen(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.REFUND_ALREADY_OPEN,
    'A refund request for this order is already open',
    'يوجد بالفعل طلب استرداد مفتوح لهذا الطلب',
  );
}

export function courseNotReadyForSubmission(
  failedItems: string[],
): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.COURSE_NOT_READY_FOR_SUBMISSION,
    'This course is not ready for submission',
    'هذه الدورة غير جاهزة للإرسال للمراجعة',
    failedItems,
  );
}

export function applicationNotReadyForSubmission(
  missingFields: string[],
): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.APPLICATION_NOT_READY_FOR_SUBMISSION,
    'This application is missing required fields',
    'يفتقد هذا الطلب إلى حقول مطلوبة',
    missingFields,
  );
}

export class MarketplaceConflictExceptionWithDetails extends ConflictException {
  constructor(
    code: MarketplaceErrorCode,
    messageEn: string,
    messageAr: string,
    details?: Record<string, unknown>,
  ) {
    super({ code, ...biBody(messageEn, messageAr), ...(details ?? {}) });
  }
}

export function applicationAlreadyOpen(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.APPLICATION_ALREADY_OPEN,
    'You already have an open instructor application',
    'لديك بالفعل طلب انضمام كمدرّب مفتوح',
  );
}

export function applicationResubmissionBlocked(
  reason: 'wait_period' | 'attempt_limit',
  availableFrom?: Date,
): MarketplaceConflictExceptionWithDetails {
  const messageEn =
    reason === 'wait_period'
      ? 'You must wait before resubmitting your application'
      : 'You have reached the maximum number of applications';
  const messageAr =
    reason === 'wait_period'
      ? 'يجب الانتظار قبل إعادة تقديم طلبك'
      : 'لقد وصلت إلى الحد الأقصى لعدد الطلبات';
  return new MarketplaceConflictExceptionWithDetails(
    MARKETPLACE_ERROR_CODES.APPLICATION_RESUBMISSION_BLOCKED,
    messageEn,
    messageAr,
    { reason, ...(availableFrom ? { availableFrom: availableFrom.toISOString() } : {}) },
  );
}

export function pageSizeExceedsMaximum(maximum: number): MarketplaceBadRequestException {
  return new MarketplaceBadRequestException(
    MARKETPLACE_ERROR_CODES.PAGE_SIZE_EXCEEDS_MAXIMUM,
    `Page size cannot exceed ${maximum}`,
    `لا يمكن أن يتجاوز حجم الصفحة ${maximum}`,
  );
}

export function idempotencyKeyMissing(): MarketplaceBadRequestException {
  return new MarketplaceBadRequestException(
    MARKETPLACE_ERROR_CODES.IDEMPOTENCY_KEY_MISSING,
    'An Idempotency-Key header is required for this request',
    'يلزم ترويسة Idempotency-Key لهذا الطلب',
  );
}

export function idempotencyKeyConflict(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
    'This idempotency key was already used with a different request',
    'تم استخدام مفتاح idempotency هذا مسبقًا بطلب مختلف',
  );
}

export function signedUrlExpired(): MarketplaceForbiddenException {
  return new MarketplaceForbiddenException(
    MARKETPLACE_ERROR_CODES.SIGNED_URL_EXPIRED,
    'This link has expired or you no longer have access',
    'انتهت صلاحية هذا الرابط أو لم يعد الوصول متاحًا لك',
  );
}

export function categoryReferenced(courseCount: number): MarketplaceConflictExceptionWithDetails {
  return new MarketplaceConflictExceptionWithDetails(
    MARKETPLACE_ERROR_CODES.CATEGORY_REFERENCED,
    `This category is assigned to ${courseCount} course(s) and cannot be deleted`,
    `هذه الفئة مُعيَّنة لـ ${courseCount} دورة/دورات ولا يمكن حذفها`,
    { courseCount },
  );
}

export function categoryDepthExceeded(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.CATEGORY_DEPTH_EXCEEDED,
    'A sub-category cannot itself have a parent — the taxonomy supports at most two levels',
    'لا يمكن أن يكون للفئة الفرعية فئة أصل خاصة بها — يدعم التصنيف مستويين كحد أقصى',
  );
}

export function courseFreePreviewBoundExceeded(bound: number): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.COURSE_FREE_PREVIEW_BOUND_EXCEEDED,
    `This course cannot have more than ${bound} free-preview lesson(s)`,
    `لا يمكن أن تحتوي هذه الدورة على أكثر من ${bound} درس/دروس معاينة مجانية`,
    [String(bound)],
  );
}

export function courseHasEnrollments(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.COURSE_HAS_ENROLLMENTS,
    'This course has at least one enrollment and cannot be deleted — unpublish it instead',
    'هذه الدورة بها تسجيل واحد على الأقل ولا يمكن حذفها — قم بإلغاء نشرها بدلاً من ذلك',
  );
}

export function courseNotEditableWhileUnderReview(): MarketplaceForbiddenException {
  return new MarketplaceForbiddenException(
    MARKETPLACE_ERROR_CODES.COURSE_NOT_EDITABLE_UNDER_REVIEW,
    'This course is under review and cannot be edited until an administrator decides',
    'هذه الدورة قيد المراجعة ولا يمكن تعديلها حتى يتخذ أحد المسؤولين قرارًا',
  );
}

export function courseIllegalTransition(from: string, to: string): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.COURSE_ILLEGAL_TRANSITION,
    `A course cannot move from ${from} to ${to}`,
    `لا يمكن أن تنتقل الدورة من ${from} إلى ${to}`,
  );
}

/** FR-073 — the caller lost a concurrent-decision race; the course was already decided by someone else. */
export function courseAlreadyDecided(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.COURSE_ALREADY_DECIDED,
    'This course was already decided by another reviewer',
    'تم بالفعل اتخاذ قرار بشأن هذه الدورة من قبل مراجع آخر',
  );
}

/** FR-103 — never reachable for a course that WAS published when the order was created; settlement still proceeds for those. */
export function courseNotPurchasable(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.COURSE_NOT_PURCHASABLE,
    'This course is not currently available for purchase',
    'هذه الدورة غير متاحة للشراء حاليًا',
  );
}

/** FR-098. */
export function selfPurchaseNotAllowed(): MarketplaceForbiddenException {
  return new MarketplaceForbiddenException(
    MARKETPLACE_ERROR_CODES.SELF_PURCHASE_NOT_ALLOWED,
    'You cannot purchase your own course',
    'لا يمكنك شراء دورتك الخاصة',
  );
}

/** The database-level backstop is `UQ_mp_orders_open_per_course`; this is the friendly app-level check ahead of it. */
export function orderAlreadyOpen(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.ORDER_ALREADY_OPEN,
    'You already have an order for this course awaiting payment, or already own it',
    'لديك بالفعل طلب لهذه الدورة بانتظار الدفع، أو أنك تمتلكها بالفعل',
  );
}

/** FR-121 — `limit` names which bound was reached ("per_minute" or "per_day"), never both, so the client shows the exact retry guidance. */
export function freeEnrollmentRateLimited(
  limit: 'per_minute' | 'per_day',
): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.FREE_ENROLLMENT_RATE_LIMITED,
    `Free enrollment rate limit reached (${limit})`,
    `تم الوصول إلى الحد الأقصى لمعدل التسجيل المجاني (${limit})`,
    [limit],
  );
}

/** FR-111. Checked before any order is created — never leaves a stray order behind for a course that turns out not to be free. */
export function courseNotFree(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.COURSE_NOT_FREE,
    'This course is not free — use checkout to purchase it',
    'هذه الدورة ليست مجانية — استخدم الدفع لشرائها',
  );
}

/** FR-054a. */
export function coursePermanentlyRemoved(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.COURSE_PERMANENTLY_REMOVED,
    'This course was permanently removed and can never be republished',
    'تمت إزالة هذه الدورة بشكل دائم ولا يمكن إعادة نشرها أبدًا',
  );
}

/** FR-255. The database-level backstop is `UQ_mp_reviews_learner_course`; this is the friendly app-level check ahead of it. */
export function reviewAlreadyExists(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.REVIEW_ALREADY_EXISTS,
    'You have already reviewed this course — edit your existing review instead',
    'لقد قمت بالفعل بتقييم هذه الدورة — عدّل تقييمك الحالي بدلاً من ذلك',
  );
}

/** FR-209, FR-325 — `minimumMinor` names the exact figure, per currency, so the client never has to hard-code it either. */
export function payoutBelowMinimum(minimumMinor: number, currency: string): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.PAYOUT_BELOW_MINIMUM,
    `The minimum payout amount is ${minimumMinor} ${currency} minor units`,
    `الحد الأدنى لمبلغ السحب هو ${minimumMinor} ${currency} (بالوحدة الصغرى)`,
    [String(minimumMinor), currency],
  );
}

export function payoutInsufficientBalance(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.PAYOUT_INSUFFICIENT_BALANCE,
    'This amount exceeds your current available balance',
    'هذا المبلغ يتجاوز رصيدك المتاح الحالي',
  );
}

export function payoutAccountInUse(): MarketplaceConflictException {
  return new MarketplaceConflictException(
    MARKETPLACE_ERROR_CODES.PAYOUT_ACCOUNT_IN_USE,
    'This payout account is referenced by an in-flight payout request and cannot be removed',
    'حساب السحب هذا مرتبط بطلب سحب قيد التنفيذ ولا يمكن إزالته',
  );
}

export function payoutAccountCurrencyMismatch(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.PAYOUT_ACCOUNT_CURRENCY_MISMATCH,
    'The destination account does not accept this currency',
    'حساب الوجهة لا يقبل هذه العملة',
  );
}

export function adjustmentCurrencyNotHeld(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.ADJUSTMENT_CURRENCY_NOT_HELD,
    'This instructor holds no earnings in that currency',
    'لا يملك هذا المدرّب أي أرباح بهذه العملة',
  );
}

export function adjustmentWouldGoNegative(): MarketplaceUnprocessableException {
  return new MarketplaceUnprocessableException(
    MARKETPLACE_ERROR_CODES.ADJUSTMENT_WOULD_GO_NEGATIVE,
    'This adjustment would drive the available balance negative',
    'هذا التعديل سيؤدي إلى رصيد متاح سالب',
  );
}
