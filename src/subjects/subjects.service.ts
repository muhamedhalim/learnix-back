import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, Repository, SelectQueryBuilder } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import {
  SubjectApprovedEvent,
  SubjectCreatedEvent,
  SubjectDeletedEvent,
  SubjectReactivatedEvent,
  SubjectRejectedEvent,
  SubjectSuspendedEvent,
  SubjectUpdatedEvent,
} from '../activity-logs/events/audit.events';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { TeachersService } from '../teachers/teachers.service';
import {
  AdminSubjectFilterDto,
  ApproveSubjectDto,
  CreateSubjectDto,
  RejectSubjectDto,
  SubjectFilterDto,
  SuspendSubjectDto,
  TeacherSubjectFilterDto,
  UpdateSubjectDto,
} from './dto';
import { SubjectStatus } from './entities/subject-status.enum';
import { Subject } from './entities/subject.entity';
import { SubjectAdminView, SubjectWithCounts } from './interfaces';

/** Who is asking, which decides which rows a read may return. */
type Audience =
  | { kind: 'public' }
  | { kind: 'teacher'; teacherId: string }
  | { kind: 'admin'; status?: SubjectStatus | undefined; ownerId?: string | undefined };

/** Request context for audit trails. Optional so internal callers still work. */
interface ActorContext {
  actorId: string;
  ipAddress?: string | undefined;
}

/** Parsed relationship counts for one subject. @see SubjectsService.loadSubjectCounts */
interface SubjectCountsRow {
  teachersCount: number;
  lessonsCount: number;
  coursesCount: number;
}

/** Fields the public catalogue exposes. Deliberately excludes owner + status. */
const PUBLIC_SELECT = [
  'subject.id',
  'subject.name',
  'subject.name_ar',
  'subject.description',
  'subject.description_ar',
  'subject.thumbnail',
  'subject.created_at',
  'subject.updated_at',
] as const;

/** Tables holding a `subject_id`, checked before a subject may be deleted. */
const REFERENCE_COUNTS: { key: string; sql: string }[] = [
  { key: 'lessons', sql: `SELECT count(*) FROM lessons WHERE subject_id = $1 AND deleted_at IS NULL` },
  {
    key: 'packages',
    sql: `SELECT count(*) FROM lesson_packages WHERE subject_id = $1 AND deleted_at IS NULL`,
  },
  { key: 'exams', sql: `SELECT count(*) FROM exams WHERE subject_id = $1 AND deleted_at IS NULL` },
  {
    key: 'questions',
    sql: `SELECT count(*) FROM questions WHERE subject_id = $1 AND deleted_at IS NULL`,
  },
  { key: 'books', sql: `SELECT count(*) FROM books WHERE subject_id = $1 AND deleted_at IS NULL` },
  // teacher_subjects has no deleted_at — it is a plain join table.
  { key: 'teacherLinks', sql: `SELECT count(*) FROM teacher_subjects WHERE subject_id = $1` },
  // The gamification tables carry a raw subject_id with no FK, so nothing at
  // the DB level would stop a delete from orphaning them. Counted here so it
  // does not happen silently.
  { key: 'questionSolves', sql: `SELECT count(*) FROM question_solves WHERE subject_id = $1` },
  { key: 'practiceSessions', sql: `SELECT count(*) FROM practice_sessions WHERE subject_id = $1` },
  {
    key: 'studentRatings',
    sql: `SELECT count(*) FROM student_subject_ratings WHERE subject_id = $1`,
  },
];

@Injectable()
export class SubjectsService {
  private readonly logger = new Logger(SubjectsService.name);

  constructor(
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    private readonly dataSource: DataSource,
    private readonly activityLogs: ActivityLogsService,
    private readonly teachersService: TeachersService,
  ) {}

  // ───────────────────────────────────────────────────────── creation ──────

  /**
   * Create a subject as an administrator — live immediately, platform-owned.
   */
  public async create(createSubjectDto: CreateSubjectDto, actor?: ActorContext): Promise<Subject> {
    const savedSubject = await this.persistNew(createSubjectDto, {
      status: SubjectStatus.APPROVED,
      ownerId: null,
    });

    this.logger.log(`Created subject: ${savedSubject.name} (ID: ${savedSubject.id})`);

    if (actor) {
      await this.activityLogs.recordAuditEvent(
        new SubjectCreatedEvent(
          actor.actorId,
          savedSubject.id,
          { name: savedSubject.name, actorRole: 'admin', status: savedSubject.status },
          actor.ipAddress,
        ),
      );
    }

    return savedSubject;
  }

  /**
   * Create a subject as a teacher. Enters the approval queue: usable by its
   * author right away, invisible to everyone else until an admin approves it.
   */
  public async createByTeacher(
    teacherId: string,
    createSubjectDto: CreateSubjectDto,
    ipAddress?: string,
  ): Promise<Subject> {
    const savedSubject = await this.persistNew(createSubjectDto, {
      status: SubjectStatus.PENDING_APPROVAL,
      ownerId: teacherId,
    });

    this.logger.log(
      `Teacher ${teacherId} submitted subject: ${savedSubject.name} (ID: ${savedSubject.id})`,
    );

    await this.activityLogs.recordAuditEvent(
      new SubjectCreatedEvent(
        teacherId,
        savedSubject.id,
        { name: savedSubject.name, actorRole: 'teacher', status: savedSubject.status },
        ipAddress,
      ),
    );

    return savedSubject;
  }

  // ──────────────────────────────────────────────────────────── reads ──────

  /**
   * Public catalogue: approved subjects only, no owner or status exposed.
   */
  public async findAll(filter: SubjectFilterDto): Promise<PaginatedResponse<SubjectWithCounts>> {
    return await this.listPublic(filter, { kind: 'public' });
  }

  /**
   * Admin catalogue: every subject, filterable by status and owner, with the
   * owner's name resolved for the table.
   */
  public async findAllForAdmin(
    filter: AdminSubjectFilterDto,
  ): Promise<PaginatedResponse<SubjectAdminView>> {
    return await this.listManaged(filter, {
      kind: 'admin',
      status: filter.status,
      ownerId: filter.ownerId,
    });
  }

  /** Admin approval queue. */
  public async findPendingForAdmin(
    filter: SubjectFilterDto,
  ): Promise<PaginatedResponse<SubjectAdminView>> {
    return await this.listManaged(filter, {
      kind: 'admin',
      status: SubjectStatus.PENDING_APPROVAL,
    });
  }

  /**
   * A teacher's own submissions, in any status. Scoped by owner, so it reuses
   * the management projection — the teacher needs to see their own status and
   * any rejection reason.
   */
  public async findMineForTeacher(
    teacherId: string,
    filter: TeacherSubjectFilterDto,
  ): Promise<PaginatedResponse<SubjectAdminView>> {
    return await this.listManaged(filter, {
      kind: 'admin',
      status: filter.status,
      ownerId: teacherId,
    });
  }

  /**
   * Subjects a teacher may attach to their own content: the approved
   * catalogue plus their own pending submissions.
   */
  public async findSelectableForTeacher(
    teacherId: string,
    filter: SubjectFilterDto,
  ): Promise<PaginatedResponse<SubjectWithCounts>> {
    return await this.listPublic(filter, { kind: 'teacher', teacherId });
  }

  /**
   * Unscoped lookup. Internal callers only — it ignores status and ownership,
   * so never hand its result straight to a public or teacher-facing route.
   */
  public async findOne(id: string): Promise<Subject> {
    const subject = await this.subjectsRepository.findOne({
      where: { id },
    });

    if (!subject) {
      throw new NotFoundException(
        biBody(`Subject with ID ${id} not found`, `المادة بالمعرّف ${id} غير موجودة`),
      );
    }

    return subject;
  }

  /** Public single read: anything not approved is indistinguishable from absent. */
  public async findOnePublic(id: string): Promise<Subject> {
    const subject = await this.subjectsRepository.findOne({
      where: { id, status: SubjectStatus.APPROVED },
    });

    if (!subject) {
      throw new NotFoundException(
        biBody(`Subject with ID ${id} not found`, `المادة بالمعرّف ${id} غير موجودة`),
      );
    }

    return subject;
  }

  /** Teacher single read — ownership enforced, see {@link findOwnedSubject}. */
  public async findOneForTeacher(id: string, teacherId: string): Promise<Subject> {
    return await this.findOwnedSubject(id, teacherId);
  }

  // ─────────────────────────────────────────────────────────── writes ──────

  /**
   * Administrative edit. Works on any subject in any status.
   */
  public async update(
    id: string,
    updateSubjectDto: UpdateSubjectDto,
    actor?: ActorContext,
  ): Promise<Subject> {
    const subject = await this.findOne(id);
    const changedFields = await this.applyUpdate(subject, updateSubjectDto);
    const updatedSubject = await this.save(subject);

    this.logger.log(`Updated subject: ${updatedSubject.name} (ID: ${id})`);

    if (actor) {
      await this.activityLogs.recordAuditEvent(
        new SubjectUpdatedEvent(
          actor.actorId,
          id,
          { name: updatedSubject.name, actorRole: 'admin', changedFields },
          actor.ipAddress,
        ),
      );
    }

    return updatedSubject;
  }

  /**
   * Teacher edit of their own subject. Allowed while pending or rejected only;
   * editing a rejected subject re-submits it for review.
   */
  public async updateByTeacher(
    id: string,
    teacherId: string,
    updateSubjectDto: UpdateSubjectDto,
    ipAddress?: string,
  ): Promise<Subject> {
    const subject = await this.findOwnedSubject(id, teacherId);
    this.assertTeacherMayModify(subject);

    const changedFields = await this.applyUpdate(subject, updateSubjectDto);

    // Editing a rejected subject is a re-submission: back into the queue with
    // the stale reviewer feedback cleared.
    if (subject.status === SubjectStatus.REJECTED) {
      subject.status = SubjectStatus.PENDING_APPROVAL;
      subject.rejection_reason = null;
      subject.reviewed_by_admin_id = null;
      subject.reviewed_at = null;
      changedFields.push('status');
    }

    const updatedSubject = await this.save(subject);

    await this.activityLogs.recordAuditEvent(
      new SubjectUpdatedEvent(
        teacherId,
        id,
        { name: updatedSubject.name, actorRole: 'teacher', changedFields },
        ipAddress,
      ),
    );

    return updatedSubject;
  }

  /** Administrative soft delete. Blocked while the subject is still in use. */
  public async remove(id: string, actor?: ActorContext): Promise<void> {
    const subject = await this.findOne(id);
    await this.assertNotReferenced(id);

    await this.subjectsRepository.softRemove(subject);

    this.logger.log(`Deleted subject: ${subject.name} (ID: ${id})`);

    if (actor) {
      await this.activityLogs.recordAuditEvent(
        new SubjectDeletedEvent(
          actor.actorId,
          id,
          { name: subject.name, actorRole: 'admin' },
          actor.ipAddress,
        ),
      );
    }
  }

  /** Teacher soft delete of their own subject, while pending or rejected. */
  public async removeByTeacher(id: string, teacherId: string, ipAddress?: string): Promise<void> {
    const subject = await this.findOwnedSubject(id, teacherId);
    this.assertTeacherMayModify(subject);
    await this.assertNotReferenced(id);

    await this.subjectsRepository.softRemove(subject);

    this.logger.log(`Teacher ${teacherId} deleted subject: ${subject.name} (ID: ${id})`);

    await this.activityLogs.recordAuditEvent(
      new SubjectDeletedEvent(teacherId, id, { name: subject.name, actorRole: 'teacher' }, ipAddress),
    );
  }

  // ─────────────────────────────────────────────────────── moderation ──────

  /** Approve a pending or rejected subject, publishing it to the catalogue. */
  public async approve(
    id: string,
    adminId: string,
    dto: ApproveSubjectDto,
    ipAddress?: string,
  ): Promise<Subject> {
    const subject = await this.findOne(id);
    this.assertTransition(subject, SubjectStatus.APPROVED, [
      SubjectStatus.PENDING_APPROVAL,
      SubjectStatus.REJECTED,
    ]);

    subject.status = SubjectStatus.APPROVED;
    subject.rejection_reason = null;
    this.stampReview(subject, adminId);
    const updated = await this.save(subject);

    const notes = dto.notes?.trim();
    await this.activityLogs.recordAuditEvent(
      new SubjectApprovedEvent(
        adminId,
        id,
        {
          name: updated.name,
          ownerTeacherId: updated.created_by_teacher_id,
          ...(notes !== undefined && notes !== '' ? { notes } : {}),
        },
        ipAddress,
      ),
    );

    return updated;
  }

  /** Reject a pending subject. The reason is shown to the owning teacher. */
  public async reject(
    id: string,
    adminId: string,
    dto: RejectSubjectDto,
    ipAddress?: string,
  ): Promise<Subject> {
    const subject = await this.findOne(id);
    this.assertTransition(subject, SubjectStatus.REJECTED, [SubjectStatus.PENDING_APPROVAL]);

    const reason = dto.reason.trim();
    subject.status = SubjectStatus.REJECTED;
    subject.rejection_reason = reason;
    this.stampReview(subject, adminId);
    const updated = await this.save(subject);

    await this.activityLogs.recordAuditEvent(
      new SubjectRejectedEvent(
        adminId,
        id,
        { name: updated.name, ownerTeacherId: updated.created_by_teacher_id, reason },
        ipAddress,
      ),
    );

    return updated;
  }

  /**
   * Suspend an approved subject. It disappears from every read path — public,
   * teacher-selectable, and the owner's own dropdowns — but nothing is
   * unlinked: lessons, courses, exams, questions and books that already point
   * at it keep working and stay editable.
   */
  public async suspend(
    id: string,
    adminId: string,
    dto: SuspendSubjectDto,
    ipAddress?: string,
  ): Promise<Subject> {
    const subject = await this.findOne(id);
    this.assertTransition(subject, SubjectStatus.SUSPENDED, [SubjectStatus.APPROVED]);

    const reason = dto.reason.trim();
    subject.status = SubjectStatus.SUSPENDED;
    subject.rejection_reason = reason;
    this.stampReview(subject, adminId);
    const updated = await this.save(subject);

    await this.activityLogs.recordAuditEvent(
      new SubjectSuspendedEvent(
        adminId,
        id,
        { name: updated.name, ownerTeacherId: updated.created_by_teacher_id, reason },
        ipAddress,
      ),
    );

    return updated;
  }

  /** Lift a suspension, returning the subject to the catalogue. */
  public async reactivate(id: string, adminId: string, ipAddress?: string): Promise<Subject> {
    const subject = await this.findOne(id);
    this.assertTransition(subject, SubjectStatus.APPROVED, [
      SubjectStatus.SUSPENDED,
      SubjectStatus.REJECTED,
    ]);

    const previousStatus = subject.status;
    subject.status = SubjectStatus.APPROVED;
    subject.rejection_reason = null;
    this.stampReview(subject, adminId);
    const updated = await this.save(subject);

    await this.activityLogs.recordAuditEvent(
      new SubjectReactivatedEvent(
        adminId,
        id,
        { name: updated.name, ownerTeacherId: updated.created_by_teacher_id, previousStatus },
        ipAddress,
      ),
    );

    return updated;
  }

  // ──────────────────────────────────────────────────────── legacy API ─────

  /**
   * Teachers who teach this subject — `GET /subjects/:id/teachers`.
   *
   * The relationship is the explicit `teacher_subjects` join table, not an
   * inference from who happens to own content tagged with the subject: a
   * teacher declares their subjects on their profile, and that declaration is
   * what the directory is built on.
   *
   * Delegates to `TeachersService.findApprovedTeachersPublic` rather than
   * querying here, so this unauthenticated route returns exactly the sanitized
   * public projection (no email, phone or status) and applies exactly the same
   * visibility rule — approved, non-deleted teacher with a non-deleted user.
   * Previously this returned a hardcoded empty page (DEF-007).
   */
  public async findTeachersBySubject(
    subjectId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    // 404s unless the subject exists and is in the public catalogue, so this
    // route cannot be used to probe pending/suspended subjects.
    await this.findOnePublic(subjectId);

    const result = await this.teachersService.findApprovedTeachersPublic({
      subjectId,
      page,
      limit,
    });

    return {
      data: result.data as unknown as Record<string, unknown>[],
      meta: result.meta,
    };
  }

  /**
   * Every subject with its relationship counts — `GET /admin/subjects/counts`.
   *
   * Counts come from one grouped query over the returned page rather than a
   * count per subject; see {@link loadSubjectCounts} for the definitions.
   */
  public async getSubjectsWithCounts(): Promise<SubjectWithCounts[]> {
    const subjects = await this.subjectsRepository.find({
      order: { name: 'ASC', id: 'ASC' },
      take: 100,
    });

    const counts = await this.loadSubjectCounts(subjects.map((subject) => subject.id));
    return subjects.map((subject) => this.withCounts(subject, counts));
  }

  // ────────────────────────────────────────────────────────── private ──────

  /** Shared body of {@link create} and {@link createByTeacher}. */
  private async persistNew(
    dto: CreateSubjectDto,
    ownership: { status: SubjectStatus; ownerId: string | null },
  ): Promise<Subject> {
    const name = dto.name.trim();
    await this.assertNameAvailable(name);

    const subject = this.subjectsRepository.create({
      name,
      name_ar: dto.name_ar?.trim() ?? null,
      description: dto.description ?? null,
      description_ar: dto.description_ar ?? null,
      thumbnail: dto.thumbnail ?? null,
      status: ownership.status,
      created_by_teacher_id: ownership.ownerId,
      rejection_reason: null,
      reviewed_by_admin_id: null,
      reviewed_at: null,
    });

    return await this.save(subject);
  }

  /** Copy a patch onto an entity, returning the names of the fields touched. */
  private async applyUpdate(subject: Subject, dto: UpdateSubjectDto): Promise<string[]> {
    const changedFields: string[] = [];

    if (dto.name !== undefined && dto.name !== '') {
      const name = dto.name.trim();
      if (name !== subject.name) {
        await this.assertNameAvailable(name, subject.id);
        subject.name = name;
        changedFields.push('name');
      }
    }
    if (dto.name_ar !== undefined) {
      subject.name_ar = dto.name_ar.trim();
      changedFields.push('name_ar');
    }
    if (dto.description !== undefined) {
      subject.description = dto.description;
      changedFields.push('description');
    }
    if (dto.description_ar !== undefined) {
      subject.description_ar = dto.description_ar;
      changedFields.push('description_ar');
    }
    if (dto.thumbnail !== undefined) {
      subject.thumbnail = dto.thumbnail;
      changedFields.push('thumbnail');
    }

    return changedFields;
  }

  /**
   * Save, translating the `uq_subjects_name_ci` unique violation into the same
   * 409 the pre-check raises. The pre-check gives a friendly bilingual message
   * for the common case; this closes the check-then-insert race.
   */
  private async save(subject: Subject): Promise<Subject> {
    try {
      return await this.subjectsRepository.save(subject);
    } catch (error) {
      if (this.isNameUniqueViolation(error)) {
        throw this.duplicateNameError(subject.name);
      }
      throw error;
    }
  }

  /**
   * Names are unique platform-wide, case-insensitively and ignoring
   * surrounding whitespace, across live (non-soft-deleted) rows only.
   */
  private async assertNameAvailable(name: string, excludeId?: string): Promise<void> {
    const qb = this.subjectsRepository
      .createQueryBuilder('s')
      .where('lower(btrim(s.name)) = lower(btrim(:name))', { name })
      .andWhere('s.deleted_at IS NULL');

    if (excludeId !== undefined) {
      qb.andWhere('s.id <> :excludeId', { excludeId });
    }

    if (await qb.getExists()) {
      throw this.duplicateNameError(name);
    }
  }

  private duplicateNameError(name: string): ConflictException {
    return new ConflictException(
      biBody(
        `Subject with name "${name}" already exists`,
        `توجد مادة بالاسم "${name}" بالفعل`,
      ),
    );
  }

  /**
   * Only the `uq_subjects_name_ci` violation maps to "name taken" — matching on
   * the bare 23505 would swallow unrelated unique violations behind a
   * misleading message.
   */
  private isNameUniqueViolation(error: unknown): boolean {
    const err = error as {
      code?: string;
      constraint?: string;
      driverError?: { code?: string; constraint?: string };
    };
    const code = err.code ?? err.driverError?.code;
    const constraint = err.constraint ?? err.driverError?.constraint;
    return code === '23505' && constraint === 'uq_subjects_name_ci';
  }

  /**
   * Resolve a subject the given teacher is allowed to manage.
   *
   * Deviates from the usual 404-absent / 403-other-owner split in one case: a
   * non-approved subject owned by someone else 404s rather than 403s. A row
   * this teacher cannot see is indistinguishable from an absent one, and a 403
   * here would let anyone enumerate other teachers' unpublished drafts.
   */
  private async findOwnedSubject(id: string, teacherId: string): Promise<Subject> {
    const subject = await this.subjectsRepository.findOne({ where: { id } });

    if (!subject) {
      throw new NotFoundException(
        biBody(`Subject with ID ${id} not found`, `المادة بالمعرّف ${id} غير موجودة`),
      );
    }

    if (subject.created_by_teacher_id !== teacherId) {
      if (subject.status !== SubjectStatus.APPROVED) {
        throw new NotFoundException(
          biBody(`Subject with ID ${id} not found`, `المادة بالمعرّف ${id} غير موجودة`),
        );
      }
      throw new ForbiddenException(
        biBody(
          'You can only manage subjects you created',
          'يمكنك فقط إدارة المواد التي أنشأتها',
        ),
      );
    }

    return subject;
  }

  /**
   * A teacher may change their subject only while it is awaiting review or has
   * been sent back. Once approved it is shared catalogue data, and once
   * suspended it is under administrative hold.
   */
  private assertTeacherMayModify(subject: Subject): void {
    if (subject.status === SubjectStatus.APPROVED) {
      throw new ConflictException(
        biBody(
          'Approved subjects can only be changed by an administrator',
          'لا يمكن تعديل المواد المعتمدة إلا بواسطة المسؤول',
        ),
      );
    }
    if (subject.status === SubjectStatus.SUSPENDED) {
      throw new ConflictException(
        biBody('This subject is suspended', 'تم تعليق هذه المادة'),
      );
    }
  }

  /** Guard a moderation action against the statuses it is legal from. */
  private assertTransition(subject: Subject, to: SubjectStatus, from: SubjectStatus[]): void {
    if (from.includes(subject.status)) {
      return;
    }

    if (subject.status === to) {
      throw new ConflictException(
        biBody(`Subject is already ${to}`, 'المادة في هذه الحالة بالفعل'),
      );
    }

    throw new ConflictException(
      biBody(
        `Cannot change a ${subject.status} subject to ${to}`,
        'لا يمكن تغيير حالة المادة بهذه الطريقة',
      ),
    );
  }

  private stampReview(subject: Subject, adminId: string): void {
    subject.reviewed_by_admin_id = adminId;
    subject.reviewed_at = new Date();
  }

  /**
   * Refuse to delete a subject that content still points at. The FKs on
   * `exams`/`questions` are ON DELETE NO ACTION, so a *hard* delete would fail
   * at the database anyway — this makes the *soft* delete honest too, which is
   * what the admin UI has always claimed happens.
   */
  private async assertNotReferenced(id: string): Promise<void> {
    const sql = REFERENCE_COUNTS.map((r) => `(${r.sql}) AS "${r.key}"`).join(', ');
    const rows = (await this.dataSource.query(`SELECT ${sql}`, [id])) as Record<string, string>[];
    const row = rows[0] ?? {};

    const blocking = REFERENCE_COUNTS.map((r) => ({ key: r.key, count: Number(row[r.key] ?? 0) }))
      .filter((entry) => entry.count > 0);

    if (blocking.length === 0) {
      return;
    }

    const summary = blocking.map((entry) => `${entry.key}: ${String(entry.count)}`).join(', ');
    throw new ConflictException(
      biBody(
        `Cannot delete a subject that is still in use (${summary})`,
        `لا يمكن حذف مادة ما زالت مستخدمة (${summary})`,
      ),
    );
  }

  /** Public/teacher list: approved-catalogue projection, no owner or status. */
  private async listPublic(
    filter: SubjectFilterDto,
    audience: Audience,
  ): Promise<PaginatedResponse<SubjectWithCounts>> {
    const { rows, meta } = await this.runListQuery(filter, audience, false);
    const counts = await this.loadSubjectCounts(rows.map((subject) => subject.id));
    return {
      data: rows.map((subject) => this.withCounts(subject, counts)),
      meta,
    };
  }

  /** Management list: adds status, moderation fields and the resolved owner. */
  private async listManaged(
    filter: SubjectFilterDto,
    audience: Audience,
  ): Promise<PaginatedResponse<SubjectAdminView>> {
    const { rows, meta } = await this.runListQuery(filter, audience, true);
    const counts = await this.loadSubjectCounts(rows.map((subject) => subject.id));
    return {
      data: rows.map((subject) =>
        Object.assign(this.withCounts(subject, counts), {
          owner_name: subject.created_by_teacher?.name ?? null,
        }),
      ),
      meta,
    };
  }

  private withCounts(subject: Subject, counts: Map<string, SubjectCountsRow>): SubjectWithCounts {
    const row = counts.get(subject.id);
    return Object.assign({}, subject, {
      teachersCount: row?.teachersCount ?? 0,
      lessonsCount: row?.lessonsCount ?? 0,
      coursesCount: row?.coursesCount ?? 0,
    });
  }

  /**
   * Relationship counts for a page of subjects, in a single grouped query.
   *
   * These used to be hardcoded zeros while being rendered as "Teachers" and
   * "Lessons" columns in the admin catalogue (DEF-007). The definitions:
   *
   * - **teachersCount** — teachers linked through the `teacher_subjects` join
   *   table whose profile and user are both live and whose user is `approved`.
   *   Identical to the population `GET /subjects/:id/teachers` lists, so the
   *   count and the list can never disagree.
   * - **lessonsCount** — non-deleted lessons carrying this `subject_id`, in any
   *   publishing state. Draft lessons are included deliberately: this matches
   *   the reference count the delete guard enforces, so a subject showing 5
   *   lessons is exactly a subject whose deletion will be blocked by 5 lessons.
   * - **coursesCount** — non-deleted courses (`lesson_packages`), same rule.
   *
   * `COUNT(DISTINCT …)` on the teacher join guards against a subject being
   * counted twice if a profile ever gains duplicate join rows.
   */
  private async loadSubjectCounts(
    subjectIds: readonly string[],
  ): Promise<Map<string, SubjectCountsRow>> {
    if (subjectIds.length === 0) return new Map();

    const rows = await this.dataSource.query<
      Array<{
        subject_id: string;
        teachers_count: string;
        lessons_count: string;
        courses_count: string;
      }>
    >(
      `SELECT s.id AS subject_id,
              (SELECT COUNT(DISTINCT ts.teacher_profile_id)
                 FROM teacher_subjects ts
                 INNER JOIN teacher_profiles tp ON tp.id = ts.teacher_profile_id
                 INNER JOIN users u ON u.id = tp.user_id
                WHERE ts.subject_id = s.id
                  AND tp.deleted_at IS NULL
                  AND u.deleted_at IS NULL
                  AND u.status = 'approved')::text AS teachers_count,
              (SELECT COUNT(*)
                 FROM lessons l
                WHERE l.subject_id = s.id AND l.deleted_at IS NULL)::text AS lessons_count,
              (SELECT COUNT(*)
                 FROM lesson_packages p
                WHERE p.subject_id = s.id AND p.deleted_at IS NULL)::text AS courses_count
         FROM unnest($1::uuid[]) AS s(id)`,
      [[...subjectIds]],
    );

    return new Map(
      rows.map((row) => [
        row.subject_id,
        {
          teachersCount: Number.parseInt(row.teachers_count, 10),
          lessonsCount: Number.parseInt(row.lessons_count, 10),
          coursesCount: Number.parseInt(row.courses_count, 10),
        },
      ]),
    );
  }

  /** Shared list query for every audience. */
  private async runListQuery(
    filter: SubjectFilterDto,
    audience: Audience,
    includeOwner: boolean,
  ): Promise<{ rows: Subject[]; meta: PaginatedResponse<never>['meta'] }> {
    const { search, page = 1, limit = 20 } = filter;
    const skip = (page - 1) * limit;

    const queryBuilder = this.subjectsRepository
      .createQueryBuilder('subject')
      .select([...PUBLIC_SELECT])
      .where('subject.deleted_at IS NULL');

    if (includeOwner) {
      queryBuilder
        .addSelect([
          'subject.status',
          'subject.created_by_teacher_id',
          'subject.rejection_reason',
          'subject.reviewed_at',
        ])
        .leftJoin('subject.created_by_teacher', 'owner')
        .addSelect(['owner.id', 'owner.name']);
    }

    if (search !== undefined && search !== '') {
      queryBuilder.andWhere('subject.name ILIKE :search', {
        search: `%${search}%`,
      });
    }

    this.applyAudience(queryBuilder, audience);

    const total = await queryBuilder.getCount();

    const rows = await queryBuilder
      .orderBy('subject.created_at', 'DESC')
      .skip(skip)
      .take(limit)
      .getMany();

    const totalPages = Math.ceil(total / limit);

    return {
      rows,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /** Narrow a list query to the rows the caller is allowed to see. */
  private applyAudience(qb: SelectQueryBuilder<Subject>, audience: Audience): void {
    switch (audience.kind) {
      case 'public':
        qb.andWhere('subject.status = :approvedStatus', {
          approvedStatus: SubjectStatus.APPROVED,
        });
        return;

      case 'teacher':
        qb.andWhere(
          `(subject.status = :approvedStatus
            OR (subject.status = :pendingStatus AND subject.created_by_teacher_id = :teacherId))`,
          {
            approvedStatus: SubjectStatus.APPROVED,
            pendingStatus: SubjectStatus.PENDING_APPROVAL,
            teacherId: audience.teacherId,
          },
        );
        return;

      case 'admin':
        if (audience.status !== undefined) {
          qb.andWhere('subject.status = :filterStatus', { filterStatus: audience.status });
        }
        if (audience.ownerId !== undefined) {
          qb.andWhere('subject.created_by_teacher_id = :filterOwnerId', {
            filterOwnerId: audience.ownerId,
          });
        }
    }
  }
}
