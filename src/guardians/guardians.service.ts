import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';

import {
  DEFAULT_PARENT_NOTIFICATION_PREFERENCES,
  ParentEventType,
  TRANSACTIONAL_PARENT_EVENTS,
} from '../common/events/parent-event-type.enum';
import { maskPhone } from '../common/utils/mask.util';
import { InvalidPhoneNumberError, isEgyptianMobile, toE164 } from '../common/utils/phone.util';
import { biBody } from '../i18n/error-translator.util';
import {
  Guardian,
  GuardianRelationship,
  GuardianVerificationStatus,
  PreferredLanguage,
  StudentGuardian,
} from './entities';

/** A guardian resolved as an eligible recipient for one event. */
export interface GuardianTarget {
  guardian_id: string;
  student_id: string;
  phone_e164: string;
  full_name: string | null;
  preferred_language: PreferredLanguage;
  whatsapp_capable: boolean;
}

export interface LinkGuardianInput {
  phone: string;
  full_name?: string;
  relationship?: GuardianRelationship;
  preferred_language?: PreferredLanguage;
  is_primary?: boolean;
}

@Injectable()
export class GuardiansService {
  private readonly logger = new Logger(GuardiansService.name);

  constructor(
    @InjectRepository(Guardian)
    private readonly guardians: Repository<Guardian>,
    @InjectRepository(StudentGuardian)
    private readonly links: Repository<StudentGuardian>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Every guardian eligible to receive `eventType` for `studentId`.
   *
   * This method is the single security chokepoint of the parent pipeline. A
   * guardian is a target only when **all** of the following hold:
   *
   *  1. the link exists (so a guardian can only ever receive their own
   *     student's data — cross-student leakage is impossible by construction);
   *  2. the guardian's phone is VERIFIED (proven ownership);
   *  3. the guardian has not opted out;
   *  4. the link's master switch is on; and
   *  5. the per-event preference is on.
   *
   * Transactional events (OTP delivery) bypass 2–5: we must be able to send a
   * verification code to an unverified number, or nothing could ever be
   * verified. They never carry educational data.
   */
  public async findNotificationTargets(
    studentId: string,
    eventType: ParentEventType,
  ): Promise<GuardianTarget[]> {
    const isTransactional = TRANSACTIONAL_PARENT_EVENTS.has(eventType);

    const qb = this.links
      .createQueryBuilder('link')
      .innerJoin('link.guardian', 'g')
      .where('link.student_id = :studentId', { studentId })
      .andWhere('g.deleted_at IS NULL')
      .select([
        'link.guardian_id AS guardian_id',
        'link.student_id AS student_id',
        'link.notification_preferences AS notification_preferences',
        'g.phone_e164 AS phone_e164',
        'g.full_name AS full_name',
        'g.preferred_language AS preferred_language',
        'g.whatsapp_capable AS whatsapp_capable',
      ]);

    if (!isTransactional) {
      qb.andWhere('link.receives_notifications = true')
        .andWhere('g.opted_out_at IS NULL')
        .andWhere('g.verification_status = :verified', {
          verified: GuardianVerificationStatus.VERIFIED,
        });
    }

    const rows = await qb.getRawMany<{
      guardian_id: string;
      student_id: string;
      notification_preferences: Partial<Record<ParentEventType, boolean>> | null;
      phone_e164: string;
      full_name: string | null;
      preferred_language: PreferredLanguage;
      whatsapp_capable: boolean;
    }>();

    return rows
      .filter(
        (row) => isTransactional || this.prefersEvent(row.notification_preferences, eventType),
      )
      .map((row) => ({
        guardian_id: row.guardian_id,
        student_id: row.student_id,
        phone_e164: row.phone_e164,
        full_name: row.full_name,
        preferred_language: row.preferred_language,
        whatsapp_capable: row.whatsapp_capable,
      }));
  }

  /**
   * One page of students who have at least one guardian eligible for
   * `eventType`, ordered by id, starting after `afterStudentId`.
   *
   * This exists so the periodic-report sweep can walk the whole platform
   * without ever holding more than `limit` ids in memory. Keyset pagination
   * (`id > :cursor`) rather than OFFSET: a sweep of 200k students would make
   * OFFSET re-scan everything it had already skipped on every page, and rows
   * inserted mid-sweep would shift the window and cause skips.
   *
   * It is a **candidate** filter, not an authorisation decision. It answers
   * "who is worth building a report for" cheaply and approximately-precisely;
   * `findNotificationTargets` above is still the sole arbiter of who may
   * actually receive one, and runs again per guardian at delivery time. A
   * preference toggled off between sweep and delivery is therefore honoured.
   *
   * The preference predicate mirrors `prefersEvent`: an absent JSON key means
   * "use the default", so a student whose link has never been touched must
   * still be selected when that default is `true`.
   */
  public async findStudentsWithEligibleGuardians(
    eventType: ParentEventType,
    options: { afterStudentId?: string | undefined; limit: number },
  ): Promise<string[]> {
    const defaultsToOn =
      DEFAULT_PARENT_NOTIFICATION_PREFERENCES[
        eventType as keyof typeof DEFAULT_PARENT_NOTIFICATION_PREFERENCES
      ] ?? false;

    const qb = this.links
      .createQueryBuilder('link')
      .innerJoin('link.guardian', 'g')
      .select('DISTINCT link.student_id', 'student_id')
      .where('g.deleted_at IS NULL')
      .andWhere('link.receives_notifications = true')
      .andWhere('g.opted_out_at IS NULL')
      .andWhere('g.verification_status = :verified', {
        verified: GuardianVerificationStatus.VERIFIED,
      })
      .orderBy('link.student_id', 'ASC')
      .limit(options.limit);

    // `->>` yields NULL for an absent key, which is exactly the "no explicit
    // preference" case the default governs.
    qb.andWhere(
      defaultsToOn
        ? `COALESCE(link.notification_preferences ->> :prefKey, 'true') = 'true'`
        : `link.notification_preferences ->> :prefKey = 'true'`,
      { prefKey: eventType },
    );

    if (options.afterStudentId !== undefined) {
      qb.andWhere('link.student_id > :cursor', { cursor: options.afterStudentId });
    }

    const rows = await qb.getRawMany<{ student_id: string }>();
    return rows.map((row) => row.student_id);
  }

  /** Sparse preference lookup with a per-event default. */
  private prefersEvent(
    preferences: Partial<Record<ParentEventType, boolean>> | null,
    eventType: ParentEventType,
  ): boolean {
    const explicit = preferences?.[eventType];
    if (explicit !== undefined) return explicit;

    return (
      DEFAULT_PARENT_NOTIFICATION_PREFERENCES[
        eventType as keyof typeof DEFAULT_PARENT_NOTIFICATION_PREFERENCES
      ] ?? false
    );
  }

  /**
   * Link a guardian to a student, reusing the existing `guardians` row when the
   * normalised phone already exists. That reuse is what lets siblings share one
   * parent — and one verification.
   *
   * Runs in a transaction because promoting a new primary must demote the old
   * one atomically or the partial unique index will reject the insert.
   */
  public async linkGuardian(studentId: string, input: LinkGuardianInput): Promise<StudentGuardian> {
    return this.dataSource.transaction((manager) =>
      this.linkGuardianWith(manager, studentId, input),
    );
  }

  /**
   * `linkGuardian` for callers that already own a transaction (e.g. the bulk
   * student importer, which creates user + profile + guardian atomically).
   * Nesting `dataSource.transaction` inside one would open a second connection.
   */
  public async linkGuardianWith(
    manager: EntityManager,
    studentId: string,
    input: LinkGuardianInput,
  ): Promise<StudentGuardian> {
    const phone = toE164(input.phone);
    if (phone === null) throw new BadRequestException(new InvalidPhoneNumberError().message);

    const guardian = await this.findOrCreateGuardian(manager, phone, input);

    const existing = await manager.findOne(StudentGuardian, {
      where: { student_id: studentId, guardian_id: guardian.id },
    });
    if (existing) return existing;

    const makePrimary = input.is_primary ?? !(await this.hasPrimary(manager, studentId));
    if (makePrimary) await this.demotePrimaries(manager, studentId);

    const link = await manager.save(
      manager.create(StudentGuardian, {
        student_id: studentId,
        guardian_id: guardian.id,
        relationship: input.relationship ?? GuardianRelationship.OTHER,
        is_primary: makePrimary,
        receives_notifications: true,
        notification_preferences: {},
      }),
    );

    this.logger.log(
      `Linked guardian ${guardian.id} (${maskPhone(phone) ?? '***'}) to student ${studentId}`,
    );
    return link;
  }

  /**
   * Resolve the guardian identity without a check-then-insert race.
   *
   * Two siblings may register at the same time with the same previously unseen
   * guardian phone. A plain `findOne` followed by `save` lets both transactions
   * observe no row and then collide on `guardians.phone_e164`; because the
   * guardian write is inside account registration, the losing collision rolls
   * back that student's user and profile as well.
   *
   * PostgreSQL's targeted `ON CONFLICT` makes the identity claim atomic. The
   * losing statement waits for the winner, does nothing, and the following
   * READ COMMITTED query sees and reuses the committed guardian. No guardian
   * attributes are overwritten when an existing phone wins the conflict.
   */
  private async findOrCreateGuardian(
    manager: EntityManager,
    phone: string,
    input: LinkGuardianInput,
  ): Promise<Guardian> {
    const existing = await manager.findOne(Guardian, {
      where: { phone_e164: phone, deleted_at: IsNull() },
    });
    if (existing) return existing;

    await manager.query(
      `INSERT INTO "guardians"
        ("phone_e164", "full_name", "preferred_language", "verification_status", "whatsapp_capable")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("phone_e164") DO NOTHING`,
      [
        phone,
        input.full_name ?? null,
        input.preferred_language ?? PreferredLanguage.AR,
        GuardianVerificationStatus.UNVERIFIED,
        // Optimistic: Egyptian mobiles are overwhelmingly on WhatsApp. Demoted
        // to false the first time Meta reports the recipient as unreachable.
        isEgyptianMobile(phone),
      ],
    );

    const guardian = await manager.findOne(Guardian, {
      where: { phone_e164: phone, deleted_at: IsNull() },
    });
    if (!guardian) {
      // A conflicting soft-deleted/corrupt identity is not a successful link.
      // Surface it so the enclosing registration transaction rolls back with a
      // real error rather than acknowledging an account that was never stored.
      throw new Error('Guardian identity could not be resolved after atomic insert');
    }
    return guardian;
  }

  private async hasPrimary(manager: EntityManager, studentId: string): Promise<boolean> {
    const count = await manager.count(StudentGuardian, {
      where: { student_id: studentId, is_primary: true },
    });
    return count > 0;
  }

  private async demotePrimaries(manager: EntityManager, studentId: string): Promise<void> {
    await manager.update(StudentGuardian, { student_id: studentId }, { is_primary: false });
  }

  /** Promote one existing link to primary, demoting the rest atomically. */
  public async setPrimary(studentId: string, guardianId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const link = await manager.findOne(StudentGuardian, {
        where: { student_id: studentId, guardian_id: guardianId },
      });
      if (!link)
        throw new NotFoundException(
          biBody('Guardian is not linked to this student', 'الوصي غير مرتبط بهذا الطالب'),
        );

      await this.demotePrimaries(manager, studentId);
      await manager.update(StudentGuardian, { id: link.id }, { is_primary: true });
    });
  }

  /**
   * Batched primary-guardian phone lookup for admin/teacher list views — one
   * query for the whole page, never N+1 per row.
   *
   * "Primary" = the link flagged `is_primary` (at most one per student, DB
   * enforced by a partial unique index). Legacy students linked before that
   * flag existed may have none set, so ties fall back to the oldest linked
   * guardian — same ordering `listForStudent` already uses for a single
   * student, just resolved across many students in one round trip.
   */
  public async findPrimaryPhonesForStudents(studentIds: string[]): Promise<Map<string, string>> {
    if (studentIds.length === 0) return new Map();

    const rows = await this.links
      .createQueryBuilder('link')
      .innerJoin('link.guardian', 'g')
      .where('link.student_id IN (:...studentIds)', { studentIds })
      .andWhere('g.deleted_at IS NULL')
      .select(['link.student_id AS student_id', 'g.phone_e164 AS phone_e164'])
      .orderBy('link.is_primary', 'DESC')
      .addOrderBy('link.created_at', 'ASC')
      .getRawMany<{ student_id: string; phone_e164: string }>();

    const phonesByStudent = new Map<string, string>();
    for (const row of rows) {
      // First row per student wins — primary first, then oldest link.
      if (!phonesByStudent.has(row.student_id)) {
        phonesByStudent.set(row.student_id, row.phone_e164);
      }
    }
    return phonesByStudent;
  }

  public async listForStudent(studentId: string): Promise<StudentGuardian[]> {
    return this.links.find({
      where: { student_id: studentId },
      relations: ['guardian'],
      order: { is_primary: 'DESC', created_at: 'ASC', id: 'ASC' },
      // A guardian relationship is a small domain collection, but is still
      // explicitly bounded to prevent corrupted/imported data from creating
      // an unbounded response.
      take: 100,
    });
  }

  public async getLinkOrThrow(studentId: string, guardianId: string): Promise<StudentGuardian> {
    const link = await this.links.findOne({
      where: { student_id: studentId, guardian_id: guardianId },
      relations: ['guardian'],
    });
    if (!link)
      throw new NotFoundException(
        biBody('Guardian is not linked to this student', 'الوصي غير مرتبط بهذا الطالب'),
      );
    return link;
  }

  /**
   * Change a guardian's phone number.
   *
   * A VERIFIED guardian's number is immutable through this path: rewriting it
   * would silently transfer a proven channel to an unproven handset, which is
   * precisely how a student would redirect their own grade notifications. The
   * caller must unlink and re-add (forcing a fresh OTP) instead.
   */
  public async changePhone(
    studentId: string,
    guardianId: string,
    newPhone: string,
  ): Promise<Guardian> {
    const link = await this.getLinkOrThrow(studentId, guardianId);

    if (link.guardian.verification_status === GuardianVerificationStatus.VERIFIED) {
      throw new ForbiddenException(
        biBody(
          'This guardian phone number is verified and cannot be changed. Remove the guardian and add the new number to verify it.',
          'رقم هاتف هذا الوصي موثّق ولا يمكن تغييره. يرجى إزالة الوصي وإضافة الرقم الجديد للتحقق منه.',
        ),
      );
    }

    const phone = toE164(newPhone);
    if (phone === null) throw new BadRequestException(new InvalidPhoneNumberError().message);

    const clash = await this.guardians.findOne({
      where: { phone_e164: phone, deleted_at: IsNull() },
    });
    if (clash && clash.id !== guardianId) {
      throw new BadRequestException(
        biBody(
          'Another guardian already uses this phone number',
          'يوجد وصي آخر يستخدم رقم الهاتف هذا بالفعل',
        ),
      );
    }

    await this.guardians.update(guardianId, {
      phone_e164: phone,
      whatsapp_capable: isEgyptianMobile(phone),
      verification_status: GuardianVerificationStatus.UNVERIFIED,
      verified_at: null,
    });

    return this.findByIdOrThrow(guardianId);
  }

  public async updatePreferences(
    studentId: string,
    guardianId: string,
    patch: {
      receives_notifications?: boolean;
      notification_preferences?: Partial<Record<ParentEventType, boolean>>;
      relationship?: GuardianRelationship;
    },
  ): Promise<StudentGuardian> {
    const link = await this.getLinkOrThrow(studentId, guardianId);

    if (patch.receives_notifications !== undefined) {
      link.receives_notifications = patch.receives_notifications;
    }
    if (patch.relationship !== undefined) link.relationship = patch.relationship;
    if (patch.notification_preferences !== undefined) {
      link.notification_preferences = {
        ...link.notification_preferences,
        ...patch.notification_preferences,
      };
    }

    return this.links.save(link);
  }

  /** Language/name are guardian-wide (not per-student). */
  public async updateGuardianProfile(
    guardianId: string,
    patch: { full_name?: string; preferred_language?: PreferredLanguage },
  ): Promise<Guardian> {
    await this.guardians.update(guardianId, patch);
    return this.findByIdOrThrow(guardianId);
  }

  public async unlink(studentId: string, guardianId: string): Promise<void> {
    const link = await this.getLinkOrThrow(studentId, guardianId);
    await this.links.delete(link.id);
  }

  public async findByIdOrThrow(guardianId: string): Promise<Guardian> {
    const guardian = await this.guardians.findOne({
      where: { id: guardianId, deleted_at: IsNull() },
    });
    if (!guardian) throw new NotFoundException(biBody('Guardian not found', 'الوصي غير موجود'));
    return guardian;
  }

  /** Called by the WhatsApp adapter when Meta reports the recipient unreachable. */
  public async markWhatsAppIncapable(guardianId: string): Promise<void> {
    await this.guardians.update(guardianId, { whatsapp_capable: false });
  }

  /** Guardian-initiated STOP, or an admin acting on their behalf. */
  public async optOut(guardianId: string): Promise<void> {
    await this.guardians.update(guardianId, { opted_out_at: new Date() });
  }
}
