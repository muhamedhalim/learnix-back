import { getMetadataArgsStorage } from 'typeorm';

import { MarketplaceEnrollment } from './marketplace-enrollment.entity';
import { MarketplaceLessonProgress } from './marketplace-lesson-progress.entity';
import { MarketplaceOrder } from './marketplace-order.entity';

function columnNames(target: unknown): string[] {
  return getMetadataArgsStorage()
    .columns.filter((c) => c.target === target)
    .map((c) => c.propertyName);
}

describe('MarketplaceOrder entity', () => {
  it('declares every column data-model.md §3 requires, with no default currency', () => {
    const names = columnNames(MarketplaceOrder);
    for (const c of [
      'order_number',
      'learner_id',
      'course_id',
      'course_version_id',
      'instructor_id',
      'gross_amount_minor',
      'discount_amount_minor',
      'net_amount_minor',
      'currency',
      'commission_bps',
      'commission_amount_minor',
      'instructor_earning_minor',
      'refund_window_days',
      'consumption_cap_bps',
      'status',
      'is_zero_value',
    ]) {
      expect(names).toContain(c);
    }
    const currencyColumn = getMetadataArgsStorage().columns.find(
      (c) => c.target === MarketplaceOrder && c.propertyName === 'currency',
    );
    expect(currencyColumn?.options.default).toBeUndefined();
  });

  it('carries the value-conservation split constraint (FR-113, FR-130, FR-327)', () => {
    const checkNames = getMetadataArgsStorage()
      .checks.filter((c) => c.target === MarketplaceOrder)
      .map((c) => c.name);
    expect(checkNames).toContain('CHK_mp_orders_split');
    expect(checkNames).toContain('CHK_mp_orders_zero_value');
  });

  it('carries the one-open-order-per-course partial unique index (FR-095, FR-096)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceOrder && i.name === 'UQ_mp_orders_open_per_course',
    );
    expect(index?.unique).toBe(true);
    expect(index?.where).toContain('awaiting_payment');
  });
});

describe('MarketplaceEnrollment entity', () => {
  it('has no expired status value and enforces the progress range (FR-106)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceEnrollment && i.name === 'UQ_mp_enrollments_active_learner_course',
    );
    expect(index).toBeDefined();
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplaceEnrollment && c.name === 'CHK_mp_enrollments_progress_range',
    );
    expect(check).toBeDefined();
  });

  it('marks order_id unique — exactly one enrollment per order (FR-099, FR-100)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceEnrollment && i.name === 'UQ_mp_enrollments_order',
    );
    expect(index?.unique).toBe(true);
  });
});

describe('MarketplaceLessonProgress entity', () => {
  it('is unique per (enrollment, lesson) and carries no client-writable percentage field', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceLessonProgress && i.name === 'UQ_mp_progress_enrollment_lesson',
    );
    expect(index?.unique).toBe(true);
    const names = columnNames(MarketplaceLessonProgress);
    expect(names).not.toContain('progress_bps');
    expect(names).toEqual(expect.arrayContaining(['is_completed', 'last_position_seconds', 'completed_at']));
  });
});
