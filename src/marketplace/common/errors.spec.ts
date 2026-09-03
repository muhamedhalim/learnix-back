import {
  applicationAlreadyOpen,
  applicationNotReadyForSubmission,
  applicationResubmissionBlocked,
  categoryDepthExceeded,
  categoryReferenced,
  courseFreePreviewBoundExceeded,
  courseHasEnrollments,
  courseNotEditableWhileUnderReview,
  courseNotFree,
  courseNotPurchasable,
  courseNotReadyForSubmission,
  discountsNotApplicable,
  freeEnrollmentRateLimited,
  idempotencyKeyConflict,
  idempotencyKeyMissing,
  MARKETPLACE_ERROR_CODES,
  nothingToRefund,
  orderAlreadyOpen,
  pageSizeExceedsMaximum,
  refundAlreadyOpen,
  refundConsumptionExceeded,
  refundWindowExpired,
  selfPurchaseNotAllowed,
  signedUrlExpired,
} from './errors';

describe('marketplace error codes and exception helpers', () => {
  it.each([
    [discountsNotApplicable(), MARKETPLACE_ERROR_CODES.DISCOUNTS_NOT_APPLICABLE, 422],
    [courseNotPurchasable(), MARKETPLACE_ERROR_CODES.COURSE_NOT_PURCHASABLE, 422],
    [selfPurchaseNotAllowed(), MARKETPLACE_ERROR_CODES.SELF_PURCHASE_NOT_ALLOWED, 403],
    [orderAlreadyOpen(), MARKETPLACE_ERROR_CODES.ORDER_ALREADY_OPEN, 409],
    [freeEnrollmentRateLimited('per_minute'), MARKETPLACE_ERROR_CODES.FREE_ENROLLMENT_RATE_LIMITED, 422],
    [courseNotFree(), MARKETPLACE_ERROR_CODES.COURSE_NOT_FREE, 422],
    [nothingToRefund(), MARKETPLACE_ERROR_CODES.NOTHING_TO_REFUND, 422],
    [refundWindowExpired(), MARKETPLACE_ERROR_CODES.REFUND_WINDOW_EXPIRED, 422],
    [refundConsumptionExceeded(), MARKETPLACE_ERROR_CODES.REFUND_CONSUMPTION_EXCEEDED, 422],
    [refundAlreadyOpen(), MARKETPLACE_ERROR_CODES.REFUND_ALREADY_OPEN, 409],
    [courseNotReadyForSubmission(['Missing cover image']), MARKETPLACE_ERROR_CODES.COURSE_NOT_READY_FOR_SUBMISSION, 422],
    [pageSizeExceedsMaximum(100), MARKETPLACE_ERROR_CODES.PAGE_SIZE_EXCEEDS_MAXIMUM, 400],
    [idempotencyKeyMissing(), MARKETPLACE_ERROR_CODES.IDEMPOTENCY_KEY_MISSING, 400],
    [idempotencyKeyConflict(), MARKETPLACE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT, 409],
    [signedUrlExpired(), MARKETPLACE_ERROR_CODES.SIGNED_URL_EXPIRED, 403],
    [applicationNotReadyForSubmission(['display_name']), MARKETPLACE_ERROR_CODES.APPLICATION_NOT_READY_FOR_SUBMISSION, 422],
    [applicationAlreadyOpen(), MARKETPLACE_ERROR_CODES.APPLICATION_ALREADY_OPEN, 409],
    [applicationResubmissionBlocked('attempt_limit'), MARKETPLACE_ERROR_CODES.APPLICATION_RESUBMISSION_BLOCKED, 409],
  ])('%#: carries the correct machine-readable code and HTTP status', (exception, code, status) => {
    const response = (exception as unknown as { getStatus(): number; getResponse(): unknown }).getStatus();
    expect(response).toBe(status);
    const body = (exception as unknown as { getResponse(): { code: string; message: string; message_ar: string } }).getResponse();
    expect(body.code).toBe(code);
    expect(body.message.length).toBeGreaterThan(0);
    expect(body.message_ar.length).toBeGreaterThan(0);
  });

  it('courseNotReadyForSubmission lists every failed item', () => {
    const exception = courseNotReadyForSubmission(['Missing cover image', 'No free preview lesson']);
    const body = (exception as unknown as { getResponse(): { details: string[] } }).getResponse();
    expect(body.details).toEqual(['Missing cover image', 'No free preview lesson']);
  });

  it('applicationNotReadyForSubmission lists every missing field individually (FR-011)', () => {
    const exception = applicationNotReadyForSubmission(['display_name', 'headline']);
    const body = (exception as unknown as { getResponse(): { details: string[] } }).getResponse();
    expect(body.details).toEqual(['display_name', 'headline']);
  });

  it('applicationResubmissionBlocked states which limit was reached, and the resumable date for the wait period (FR-016)', () => {
    const waitException = applicationResubmissionBlocked('wait_period', new Date('2026-09-17T00:00:00Z'));
    const waitBody = (waitException as unknown as { getResponse(): { reason: string; availableFrom: string } }).getResponse();
    expect(waitBody.reason).toBe('wait_period');
    expect(waitBody.availableFrom).toBe('2026-09-17T00:00:00.000Z');

    const limitException = applicationResubmissionBlocked('attempt_limit');
    const limitBody = (limitException as unknown as { getResponse(): { reason: string; availableFrom?: string } }).getResponse();
    expect(limitBody.reason).toBe('attempt_limit');
    expect(limitBody.availableFrom).toBeUndefined();
  });

  it('categoryReferenced carries the referencing course count (FR-039)', () => {
    const exception = categoryReferenced(4);
    const body = (exception as unknown as { getResponse(): { code: string; courseCount: number } }).getResponse();
    expect(body.code).toBe('CATEGORY_REFERENCED');
    expect(body.courseCount).toBe(4);
  });

  it('categoryDepthExceeded carries its own code (FR-036)', () => {
    const exception = categoryDepthExceeded();
    const body = (exception as unknown as { getResponse(): { code: string } }).getResponse();
    expect(body.code).toBe('CATEGORY_DEPTH_EXCEEDED');
  });

  it('courseFreePreviewBoundExceeded states the bound (FR-049)', () => {
    const exception = courseFreePreviewBoundExceeded(2);
    const body = (exception as unknown as { getResponse(): { code: string; details: string[] } }).getResponse();
    expect(body.code).toBe('COURSE_FREE_PREVIEW_BOUND_EXCEEDED');
    expect(body.details).toEqual(['2']);
  });

  it('courseHasEnrollments and courseNotEditableWhileUnderReview carry their own codes', () => {
    expect(
      (courseHasEnrollments() as unknown as { getResponse(): { code: string } }).getResponse().code,
    ).toBe('COURSE_HAS_ENROLLMENTS');
    expect(
      (courseNotEditableWhileUnderReview() as unknown as { getResponse(): { code: string } }).getResponse().code,
    ).toBe('COURSE_NOT_EDITABLE_UNDER_REVIEW');
  });

  it('every error code is unique', () => {
    const codes = Object.values(MARKETPLACE_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
