import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ActivityLogsService } from '../../activity-logs/activity-logs.service';
import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceInstructorProfileChangesDecisionEvent } from '../events/audit.events';
import type {
  ApplicationCertificationEntry,
  ApplicationEducationEntry,
  ApplicationPortfolioItem,
  ApplicationProfessionalLink,
  ApplicationWorkExperienceEntry,
} from './entities/instructor-application.entity';
import type { PendingProfileChange } from './entities/marketplace-instructor.entity';
import { MarketplaceInstructor } from './entities/marketplace-instructor.entity';

export interface UpdateInstructorProfileFields {
  display_name?: string;
  photo_key?: string;
  headline?: string;
  headline_ar?: string;
  bio?: string;
  bio_ar?: string;
  years_of_experience?: number;
  education?: ApplicationEducationEntry[];
  certifications?: ApplicationCertificationEntry[];
  work_experience?: ApplicationWorkExperienceEntry[];
  specializations?: string[];
  skills?: string[];
  teaching_category_ids?: string[];
  portfolio_items?: ApplicationPortfolioItem[];
  professional_links?: ApplicationProfessionalLink[];
}

/**
 * FR-029's closed set: an edit to any of these fields is held for
 * administrative re-review, with the previously approved value staying
 * live until that review lands. Everything else in
 * {@link UpdateInstructorProfileFields} — skills, specialisations, teaching
 * categories, years of experience — is not in this list, so it takes
 * effect immediately, matching the spec's "and any non-public field" catch-all.
 */
const REVIEW_REQUIRED_FIELDS = [
  'display_name',
  'photo_key',
  'headline',
  'headline_ar',
  'bio',
  'bio_ar',
  'professional_links',
  'portfolio_items',
  'certifications',
  'education',
  'work_experience',
] as const satisfies readonly (keyof UpdateInstructorProfileFields)[];

type ReviewRequiredField = (typeof REVIEW_REQUIRED_FIELDS)[number];

function isReviewRequiredField(field: string): field is ReviewRequiredField {
  return (REVIEW_REQUIRED_FIELDS as readonly string[]).includes(field);
}

/**
 * FR-025 – FR-029: the instructor's own read/edit of their public profile,
 * plus the admin decision that clears or discards what FR-029 queued.
 * Capability lifecycle (approve/suspend/reinstate) stays in
 * `InstructorService` — this file is only the profile-edit half of
 * data-model.md's collapsed `marketplace_instructors` table.
 */
@Injectable()
export class InstructorProfileService {
  constructor(
    @InjectRepository(MarketplaceInstructor)
    private readonly instructors: Repository<MarketplaceInstructor>,
    private readonly activityLogs: ActivityLogsService,
  ) {}

  public async getProfile(userId: string): Promise<MarketplaceInstructor> {
    return this.getByUserIdOrThrow(userId);
  }

  /**
   * Splits `fields` into the FR-029 review-required set (queued in
   * `pending_profile_changes`, live values untouched) and everything else
   * (applied immediately). Re-editing an already-pending field replaces its
   * proposed value but keeps `previous_value` pinned to what is actually
   * still live. Proposing the live value back removes the pending entry
   * instead of queuing a no-op review.
   */
  public async updateProfile(
    userId: string,
    fields: UpdateInstructorProfileFields,
  ): Promise<MarketplaceInstructor> {
    const instructor = await this.getByUserIdOrThrow(userId);
    const live = instructor as unknown as Record<string, unknown>;
    const pending = [...(instructor.pending_profile_changes ?? [])];
    const now = new Date().toISOString();

    for (const [field, proposedValue] of Object.entries(fields)) {
      if (proposedValue === undefined) continue;

      if (isReviewRequiredField(field)) {
        const existingIndex = pending.findIndex((change) => change.field === field);
        const existingChange = existingIndex >= 0 ? pending[existingIndex] : undefined;
        const previousValue = existingChange ? existingChange.previous_value : live[field];

        if (JSON.stringify(proposedValue) === JSON.stringify(previousValue)) {
          if (existingIndex >= 0) pending.splice(existingIndex, 1);
          continue;
        }

        const entry: PendingProfileChange = { field, previous_value: previousValue, proposed_value: proposedValue, requested_at: now };
        if (existingIndex >= 0) pending[existingIndex] = entry;
        else pending.push(entry);
      } else {
        live[field] = proposedValue;
      }
    }

    instructor.pending_profile_changes = pending.length > 0 ? pending : null;
    return this.instructors.save(instructor);
  }

  /** Applies every currently queued edit at once and clears the queue. */
  public async approvePendingChanges(instructorId: string, adminId: string): Promise<MarketplaceInstructor> {
    const instructor = await this.getPendingOrThrow(instructorId);
    const pending = instructor.pending_profile_changes as PendingProfileChange[];
    const live = instructor as unknown as Record<string, unknown>;

    for (const change of pending) {
      live[change.field] = change.proposed_value;
    }
    instructor.pending_profile_changes = null;
    const saved = await this.instructors.save(instructor);

    await this.activityLogs.recordAuditEvent(
      new MarketplaceInstructorProfileChangesDecisionEvent(adminId, instructorId, {
        instructorName: instructor.display_name,
        decision: 'approved',
        fields: pending.map((change) => change.field),
      }),
    );
    return saved;
  }

  /** Discards every currently queued edit; the live values are untouched. */
  public async rejectPendingChanges(
    instructorId: string,
    adminId: string,
    reason: string,
  ): Promise<MarketplaceInstructor> {
    const instructor = await this.getPendingOrThrow(instructorId);
    const pending = instructor.pending_profile_changes as PendingProfileChange[];

    instructor.pending_profile_changes = null;
    const saved = await this.instructors.save(instructor);

    await this.activityLogs.recordAuditEvent(
      new MarketplaceInstructorProfileChangesDecisionEvent(adminId, instructorId, {
        instructorName: instructor.display_name,
        decision: 'rejected',
        fields: pending.map((change) => change.field),
        reason,
      }),
    );
    return saved;
  }

  private async getByUserIdOrThrow(userId: string): Promise<MarketplaceInstructor> {
    const instructor = await this.instructors.findOne({ where: { user_id: userId } });
    if (!instructor) {
      throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
    }
    return instructor;
  }

  private async getPendingOrThrow(instructorId: string): Promise<MarketplaceInstructor> {
    const instructor = await this.instructors.findOne({ where: { id: instructorId } });
    if (!instructor) {
      throw new NotFoundException(biBody('Instructor not found', 'المدرّب غير موجود'));
    }
    if (!instructor.pending_profile_changes || instructor.pending_profile_changes.length === 0) {
      throw new NotFoundException(
        biBody('No pending profile changes to review', 'لا توجد تعديلات على الملف الشخصي بانتظار المراجعة'),
      );
    }
    return instructor;
  }
}
