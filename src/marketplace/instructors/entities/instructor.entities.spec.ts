import { getMetadataArgsStorage } from 'typeorm';

import { InstructorApplication } from './instructor-application.entity';
import { MarketplaceInstructor } from './marketplace-instructor.entity';

function columnNames(target: unknown): string[] {
  return getMetadataArgsStorage()
    .columns.filter((c) => c.target === target)
    .map((c) => c.propertyName);
}

function columnType(target: unknown, property: string): unknown {
  const column = getMetadataArgsStorage().columns.find(
    (c) => c.target === target && c.propertyName === property,
  );
  return column?.options.type;
}

describe('InstructorApplication entity (data-model.md §1)', () => {
  const names = columnNames(InstructorApplication);

  it('declares every column data-model.md requires', () => {
    for (const column of [
      'id',
      'user_id',
      'status',
      'display_name',
      'headline',
      'headline_ar',
      'bio',
      'bio_ar',
      'years_of_experience',
      'education',
      'certifications',
      'work_experience',
      'specializations',
      'skills',
      'intended_category_ids',
      'portfolio_items',
      'professional_links',
      'photo_key',
      'document_keys',
      'reviewed_by',
      'reviewed_at',
      'decision_reason',
      'internal_notes',
      'submitted_at',
      'created_at',
      'updated_at',
    ]) {
      expect(names).toContain(column);
    }
  });

  it('declares an explicit type for every nullable string column (TypeORM rejects an inferred Object)', () => {
    for (const property of ['headline', 'headline_ar', 'bio', 'bio_ar', 'photo_key', 'decision_reason', 'internal_notes']) {
      expect(columnType(InstructorApplication, property)).toBeDefined();
    }
  });

  it('carries the partial-unique open-application index (FR-015)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === InstructorApplication && i.name === 'UQ_mp_applications_user_open',
    );
    expect(index).toBeDefined();
    expect(index?.where).toContain("'draft','submitted','under_review','approved'");
  });

  it('carries the reject-reason check constraint (FR-018)', () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === InstructorApplication && c.name === 'CHK_mp_applications_reject_reason',
    );
    expect(check).toBeDefined();
  });
});

describe('MarketplaceInstructor entity (data-model.md §1)', () => {
  const names = columnNames(MarketplaceInstructor);

  it('declares every column data-model.md requires, including the collapsed capability + profile fields', () => {
    for (const column of [
      'id',
      'user_id',
      'application_id',
      'status',
      'slug',
      'display_name',
      'headline',
      'bio',
      'years_of_experience',
      'education',
      'certifications',
      'work_experience',
      'specializations',
      'skills',
      'teaching_category_ids',
      'portfolio_items',
      'professional_links',
      'photo_key',
      'pending_profile_changes',
      'suspension_reason',
      'suspended_at',
      'suspended_by',
      'approved_at',
      'approved_by',
      'created_at',
      'updated_at',
      'deleted_at',
    ]) {
      expect(names).toContain(column);
    }
  });

  it('marks user_id unique — one capability per identity', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceInstructor && i.name === 'UQ_mp_instructors_user_id',
    );
    expect(index?.unique).toBe(true);
  });

  it('marks slug unique — a stable public address', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceInstructor && i.name === 'UQ_mp_instructors_slug',
    );
    expect(index?.unique).toBe(true);
  });

  it('carries the suspension-reason check constraint', () => {
    const check = getMetadataArgsStorage().checks.find(
      (c) => c.target === MarketplaceInstructor && c.name === 'CHK_mp_instructors_suspension_reason',
    );
    expect(check).toBeDefined();
  });
});
