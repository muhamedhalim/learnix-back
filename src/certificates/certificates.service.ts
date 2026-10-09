import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { DataSource, EntityManager, IsNull, LessThanOrEqual, QueryFailedError, Repository } from 'typeorm';

import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { PaginationMeta } from '../common/interfaces/pagination.interface';
import {
  ACTIVE_PACKAGE_PURCHASE_SQL,
  CertificateEligibilityService,
} from './certificate-eligibility.service';
import { CourseVersionItem } from '../packages/entities/course-version-item.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../packages/entities/lesson-package-item.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { User } from '../users/entities/user.entity';
import { generateCertificateNumber, generateVerificationCode } from './certificate-code.util';
import { CertificatePdfService } from './certificate-pdf.service';
import { CertificatePreviewDto, CreateTemplateDto, UpdateTemplateDto } from './dto';
import type { CertificateSource, CertificateTemplateSnapshot } from './entities/certificate.entity';
import { Certificate } from './entities/certificate.entity';
import { CertificateAutoIssuanceFailure } from './entities/certificate-auto-issuance-failure.entity';
import { CertificateHistory } from './entities/certificate-history.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import { CertificateTemplate } from './entities/certificate-template.entity';
import { CertificateTemplateStatus } from './entities/certificate-template-status.enum';

export const CERTIFICATE_ISSUED_EVENT = 'certificate.issued';

export interface CourseProgress {
  total: number;
  completed: number;
  percentage: number;
}

export interface CertificateIssuedEvent {
  certificateId: string;
  studentId: string;
  /** Null for a marketplace-sourced certificate (FR-324) — `CertificateNotificationListener` never reads this field either way. */
  packageId: string | null;
}

export interface MarketplaceCertificateInput {
  studentId: string;
  studentName: string;
  courseTitle: string;
  instructorName: string | null;
  marketplaceCourseId: string;
}

export interface BulkIssueParams {
  packageId: string;
  templateId?: string | undefined;
  studentIds?: string[] | undefined;
  /** Issue to every purchaser who has completed 100% of the course. */
  allCompleted?: boolean | undefined;
  force?: boolean | undefined;
}

export interface BulkIssueResult {
  requested: number;
  issued: number;
  skipped: number;
  failed: { studentId: string; reason: string }[];
}

const BULK_ISSUE_BATCH_SIZE = 50;

export interface PaginatedList<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPrevPage: boolean;
  };
}

/** Fields of the public-gallery projection — never leaks ids/emails/phones. */
export interface PublicCertificateCard {
  publicId: string;
  certificate_number: string;
  student_name: string;
  course_title: string;
  teacher_name: string | null;
  issued_at: Date;
}

/** T038 (W1-C6 d): anonymous, viewer-independent public catalog reads. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    @InjectRepository(Certificate)
    private readonly certificatesRepository: Repository<Certificate>,
    @InjectRepository(CertificateTemplate)
    private readonly templatesRepository: Repository<CertificateTemplate>,
    @InjectRepository(CertificateHistory)
    private readonly certificateHistoryRepository: Repository<CertificateHistory>,
    @InjectRepository(CertificateAutoIssuanceFailure)
    private readonly autoIssuanceFailuresRepository: Repository<CertificateAutoIssuanceFailure>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    @InjectRepository(LessonPackageItem)
    private readonly packageItemsRepository: Repository<LessonPackageItem>,
    @InjectRepository(CourseVersionItem)
    private readonly courseVersionItemsRepository: Repository<CourseVersionItem>,
    @InjectRepository(LessonProgress)
    private readonly progressRepository: Repository<LessonProgress>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
    private readonly pdfService: CertificatePdfService,
    private readonly eventEmitter: EventEmitter2,
    private readonly eligibility: CertificateEligibilityService,
    private readonly dataSource: DataSource,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  /* ===================== Completion ===================== */

  /**
   * Student-facing wrapper around `getCourseProgress`: only ever returns real
   * numbers to a student who actually holds a valid purchase for the course,
   * so this can't be used to probe lesson counts on a draft/unpublished/
   * unowned course. Uses the same canonical eligibility rule as issuance.
   */
  public async getMyCourseProgress(studentId: string, packageId: string): Promise<CourseProgress> {
    const purchase = await this.eligibility.findActivePurchase(studentId, packageId);
    if (!purchase) {
      return { total: 0, completed: 0, percentage: 0 };
    }
    // Hand the already-resolved purchase down so eligibility is read ONCE.
    return this.getCourseProgress(studentId, packageId, undefined, purchase);
  }

  /**
   * Course progress for many packages in one request (≤ 5 statements, whatever
   * the number of packages). Same answer as {@link getMyCourseProgress} per
   * package: a package without a currently valid purchase is `{0,0,0}` and never
   * discloses lesson counts. Completions are counted with COUNT(DISTINCT lp.id)
   * — `course_version_items (version_id, lesson_id)` has no unique constraint, so
   * COUNT(*) would double a lesson listed twice. Duplicate ids collapse.
   */
  public async getMyCourseProgressBatch(
    studentId: string,
    packageIds: readonly string[],
  ): Promise<Record<string, CourseProgress>> {
    const ids = [...new Set(packageIds)];
    const result: Record<string, CourseProgress> = {};
    for (const id of ids) result[id] = { total: 0, completed: 0, percentage: 0 };
    if (ids.length === 0) return result;

    const manager = this.dataSource.manager;
    // (1) the newest valid purchase per package (same rule and tie-break as findActivePurchase).
    const purchases = await manager.query<
      Array<{ package_id: string; course_version_id: string | null }>
    >(
      `SELECT DISTINCT ON (pp.package_id) pp.package_id, pp.course_version_id
         FROM package_purchases pp
        WHERE pp.student_id = $1 AND pp.package_id = ANY($2::uuid[])
          AND (${ACTIVE_PACKAGE_PURCHASE_SQL('pp')})
        ORDER BY pp.package_id, pp.purchased_at DESC, pp.id DESC`,
      [studentId, ids],
    );
    if (purchases.length === 0) return result;

    // (2) purchases with no version yet fall through to the package's current version
    // (a soft-deleted package resolves to none, exactly like `findOne` did).
    const unversioned = purchases.filter((p) => !p.course_version_id).map((p) => p.package_id);
    const current =
      unversioned.length > 0
        ? await manager.query<Array<{ id: string; current_version_id: string | null }>>(
            'SELECT id, current_version_id FROM lesson_packages WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
            [unversioned],
          )
        : [];
    const currentVersion = new Map(current.map((row) => [row.id, row.current_version_id]));
    const versionOf = new Map<string, string | null>(
      purchases.map((p) => [p.package_id, p.course_version_id ?? currentVersion.get(p.package_id) ?? null]),
    );
    const versionIds = [...new Set([...versionOf.values()].filter((v): v is string => v !== null))];

    // (3) + (4) locked curriculum size and completions, grouped by version.
    const [totals, done] =
      versionIds.length > 0
        ? await Promise.all([
            manager.query<Array<{ version_id: string; total: string }>>(
              'SELECT version_id, COUNT(*)::text AS total FROM course_version_items WHERE version_id = ANY($1::uuid[]) GROUP BY version_id',
              [versionIds],
            ),
            manager.query<Array<{ version_id: string; completed: string }>>(
              `SELECT cvi.version_id, COUNT(DISTINCT lp.id)::text AS completed
                 FROM lesson_progress lp
                 JOIN course_version_items cvi ON cvi.lesson_id = lp.lesson_id
                WHERE lp.student_id = $1 AND lp.completed = true AND cvi.version_id = ANY($2::uuid[])
                GROUP BY cvi.version_id`,
              [studentId, versionIds],
            ),
          ])
        : [[], []];
    const lockedTotal = new Map(totals.map((row) => [row.version_id, Number.parseInt(row.total, 10)]));
    const lockedDone = new Map(done.map((row) => [row.version_id, Number.parseInt(row.completed, 10)]));

    const apply = (packageId: string, total: number, completed: number): void => {
      result[packageId] =
        total === 0
          ? { total: 0, completed: 0, percentage: 0 }
          : { total, completed, percentage: Math.round((completed / total) * 100) };
    };

    // A version with no locked items is a still-unlocked draft: judge it by the package items.
    const draftPackages: string[] = [];
    for (const { package_id: packageId } of purchases) {
      const version = versionOf.get(packageId) ?? null;
      const total = version === null ? 0 : (lockedTotal.get(version) ?? 0);
      if (total > 0 && version !== null) apply(packageId, total, lockedDone.get(version) ?? 0);
      else draftPackages.push(packageId);
    }

    // (5) only for those draft packages.
    if (draftPackages.length > 0) {
      const rows = await manager.query<Array<{ package_id: string; total: string; completed: string }>>(
        `SELECT p.id AS package_id,
                (SELECT COUNT(*) FROM lesson_package_items i WHERE i.package_id = p.id)::text AS total,
                (SELECT COUNT(DISTINCT lp.id) FROM lesson_progress lp
                   JOIN lesson_package_items lpi ON lpi.lesson_id = lp.lesson_id
                  WHERE lpi.package_id = p.id AND lp.student_id = $1 AND lp.completed = true)::text AS completed
           FROM unnest($2::uuid[]) AS p(id)`,
        [studentId, draftPackages],
      );
      for (const row of rows) {
        apply(row.package_id, Number.parseInt(row.total, 10), Number.parseInt(row.completed, 10));
      }
    }
    return result;
  }

  /**
   * How much of a course (package) a student has completed, judged against
   * the exact curriculum snapshot they purchased — not whatever the course
   * currently, live, contains (DEF-002: adding/removing lessons after a sale
   * must never retroactively shift an existing purchaser's percentage).
   */
  public async getCourseProgress(
    studentId: string,
    packageId: string,
    manager?: EntityManager,
    resolvedPurchase?: PackagePurchase | null,
  ): Promise<CourseProgress> {
    const versionId = await this.resolveProgressVersionId(
      studentId,
      packageId,
      manager,
      resolvedPurchase,
    );

    // `versionId === null` covers a package with no version record at all —
    // e.g. a `lesson_packages` row inserted outside `PackagesService.create`
    // (a seed script, a raw-SQL fixture) that predates or bypassed the
    // DEF-002 migration/bootstrap. Treat it the same as "still an unlocked
    // draft" below rather than short-circuiting to zero, so course progress
    // never regresses for a package that simply never got versioned.
    const courseVersionItems = manager
      ? manager.getRepository(CourseVersionItem)
      : this.courseVersionItemsRepository;
    const progress = manager ? manager.getRepository(LessonProgress) : this.progressRepository;
    const packageItems = manager
      ? manager.getRepository(LessonPackageItem)
      : this.packageItemsRepository;

    const lockedTotal = versionId
      ? await courseVersionItems.count({ where: { version_id: versionId } })
      : 0;

    // `lockedTotal === 0` means this version has never been purchased by
    // anyone — it is still an unlocked draft whose content lives in
    // `LessonPackageItem`, not `CourseVersionItem` yet (see PackagesService /
    // PaymentFinalizationService). A genuinely empty *locked* version is
    // impossible: finalization refuses to sell a course with zero lessons.
    if (lockedTotal > 0) {
      const completed = await progress
        .createQueryBuilder('lp')
        .innerJoin('course_version_items', 'cvi', 'cvi.lesson_id = lp.lesson_id')
        .where('cvi.version_id = :versionId', { versionId })
        .andWhere('lp.student_id = :studentId', { studentId })
        .andWhere('lp.completed = true')
        .getCount();
      return {
        total: lockedTotal,
        completed,
        percentage: Math.round((completed / lockedTotal) * 100),
      };
    }

    const total = await packageItems.count({ where: { package_id: packageId } });
    if (total === 0) {
      return { total: 0, completed: 0, percentage: 0 };
    }
    const completed = await progress
      .createQueryBuilder('lp')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.lesson_id = lp.lesson_id')
      .where('lpi.package_id = :packageId', { packageId })
      .andWhere('lp.student_id = :studentId', { studentId })
      .andWhere('lp.completed = true')
      .getCount();
    return { total, completed, percentage: Math.round((completed / total) * 100) };
  }

  /**
   * Which curriculum snapshot a student's completion should be judged against:
   * the version their own valid purchase actually bought, resolved through the
   * SAME canonical eligibility rule issuance uses, so progress and eligibility
   * can never disagree about which purchase counts. A legacy row mid-backfill
   * whose `course_version_id` is momentarily still null falls through to the
   * package's current version, as does a caller with no valid purchase at all
   * (e.g. the read-only student progress surface, which separately returns 0%).
   */
  private async resolveProgressVersionId(
    studentId: string,
    packageId: string,
    manager?: EntityManager,
    resolvedPurchase?: PackagePurchase | null,
  ): Promise<string | null> {
    // `undefined` = not resolved by the caller yet (issuance paths); `null` = resolved, none.
    const purchase =
      resolvedPurchase !== undefined
        ? resolvedPurchase
        : await this.eligibility.findActivePurchase(studentId, packageId, manager);
    if (purchase?.course_version_id) {
      return purchase.course_version_id;
    }
    const packages = manager ? manager.getRepository(LessonPackage) : this.packagesRepository;
    const pkg = await packages.findOne({
      where: { id: packageId },
      select: { id: true, current_version_id: true },
    });
    return pkg?.current_version_id ?? null;
  }

  /* ===================== Issuance ===================== */

  /**
   * Issue (or return the existing) certificate for a completed course.
   * Idempotent per (student, package).
   *
   * Two independent gates, both mandatory (DEF-019):
   *
   *  1. ELIGIBILITY — the student must hold a valid, non-revoked purchase /
   *     entitlement for the course, resolved through the single canonical rule
   *     in `CertificateEligibilityService`. `force` does NOT bypass this: it is
   *     a completion override, not an entitlement override, so a fully refunded
   *     student can never be certified through any path.
   *  2. COMPLETION — 100% of the curriculum snapshot THEY purchased, unless
   *     `force` is set (admin override).
   *
   * Runs in one transaction that row-locks the qualifying purchase, so a
   * concurrent full refund either loses the lock (and then finds the
   * certificate to revoke) or wins it (and this issuance re-reads the revoked
   * purchase and refuses). There is no window in which a valid certificate can
   * attach to a revoked purchase.
   */
  public async issueForCourse(
    studentId: string,
    packageId: string,
    options: { force?: boolean; templateId?: string; restrictTemplateOwner?: string } = {},
  ): Promise<Certificate> {
    const existing = await this.certificatesRepository.findOne({
      where: { student_id: studentId, package_id: packageId },
    });
    if (existing) {
      // A REVOKED certificate is not a successful issuance to hand back to a
      // student who has lost their entitlement — say so instead of returning
      // a dead document as though the request had been honoured. (Restoring
      // one is `reissueCertificate`'s explicit, separately-gated job.)
      if (existing.status === CertificateStatus.REVOKED) {
        await this.eligibility.assertEligible(studentId, packageId);
      }
      return existing;
    }

    try {
      const outcome = await this.dataSource.transaction<{
        certificate: Certificate;
        created: boolean;
      }>(async (manager) => {
        const purchase = await this.eligibility.lockActivePurchase(manager, studentId, packageId);
        if (!purchase) {
          throw this.eligibility.ineligible();
        }
        // Re-check inside the lock: a concurrent issuance may have committed
        // between the unlocked pre-check above and this transaction.
        const raced = await manager.findOne(Certificate, {
          where: { student_id: studentId, package_id: packageId },
        });
        if (raced) return { certificate: raced, created: false };

        const progress = await this.getCourseProgress(studentId, packageId, manager);
        if (progress.total === 0) {
          throw new BadRequestException(
            biBody(
              'This course has no lessons to complete.',
              'لا تحتوي هذه الدورة على دروس لإكمالها.',
            ),
          );
        }
        if (progress.percentage < 100 && !options.force) {
          throw new BadRequestException(
            biBody(
              'Course is not yet complete — a certificate cannot be issued.',
              'الدورة لم تكتمل بعد — لا يمكن إصدار الشهادة.',
            ),
          );
        }

        const [student, pkg] = await Promise.all([
          manager.findOne(User, { where: { id: studentId } }),
          manager.findOne(LessonPackage, {
            where: { id: packageId },
            relations: ['teacher'],
          }),
        ]);
        if (!student) {
          throw new NotFoundException(biBody('Student not found', 'الطالب غير موجود'));
        }
        if (!pkg) {
          throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
        }

        const template = options.templateId
          ? await this.resolveIssuanceTemplate(options.templateId, options.restrictTemplateOwner)
          : pkg.certificate_template_id
            ? await this.resolveIssuanceTemplate(pkg.certificate_template_id)
            : ((await this.findDefaultTemplate(pkg.teacher_id)) ??
              (await this.findDefaultTemplate()));
        this.assertTemplateCanBeIssued(template);

        const certificate = manager.create(Certificate, {
          certificate_number: await this.uniqueNumber(),
          verification_code: await this.uniqueCode(),
          student_id: studentId,
          package_id: packageId,
          student_name: student.name,
          course_title: pkg.title,
          teacher_name: pkg.teacher?.name ?? null,
          completion_percentage: progress.percentage,
          template_id: template?.id ?? null,
          // Freeze the design NOW — later template edits must never restyle
          // this certificate.
          template_snapshot: this.snapshotOf(template),
          status: CertificateStatus.ISSUED,
          revoked_at: null,
          revoke_reason: null,
          revoked_by: null,
          revocation_context: null,
          issued_at: new Date(),
        });

        const saved = await manager.save(Certificate, certificate);
        this.logger.log(
          `Certificate ${saved.certificate_number} issued to student ${studentId} for course ${packageId}`,
        );
        return { certificate: saved, created: true };
      });
      // Emitted only after COMMIT, and only for a certificate this call
      // actually created: the notification listener reads the row back on its
      // own connection and must never race an uncommitted insert.
      if (outcome.created) {
        this.eventEmitter.emit(CERTIFICATE_ISSUED_EVENT, {
          certificateId: outcome.certificate.id,
          studentId,
          packageId,
        } satisfies CertificateIssuedEvent);
      }
      return outcome.certificate;
    } catch (error) {
      // The (student, package) unique constraint is the last line of defense
      // against two concurrent issuances; losing that race is still success.
      if (error instanceof QueryFailedError && this.isUniqueViolation(error)) {
        const winner = await this.certificatesRepository.findOne({
          where: { student_id: studentId, package_id: packageId },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  private isUniqueViolation(error: QueryFailedError): boolean {
    return (error.driverError as { code?: string } | undefined)?.code === '23505';
  }

  /**
   * Auto-issue for every VALIDLY purchased course that contains the completed
   * lesson and is now fully complete. Best-effort: a failure on one course is
   * logged and does not block the others.
   */
  public async autoIssueForCompletedLesson(studentId: string, lessonId: string): Promise<void> {
    const query = this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('course_version_items', 'cvi', 'cvi.version_id = pp.course_version_id')
      .where('pp.student_id = :studentId', { studentId })
      .andWhere('cvi.lesson_id = :lessonId', { lessonId })
      .select('DISTINCT pp.package_id', 'package_id');
    this.eligibility.applyActivePurchase(query, 'pp');
    const rows = await query.getRawMany<{ package_id: string }>();

    for (const { package_id } of rows) {
      try {
        const progress = await this.getCourseProgress(studentId, package_id);
        if (progress.percentage >= 100) {
          await this.issueForCourse(studentId, package_id);
        }
      } catch (error) {
        await this.recordAutoIssuanceFailure(studentId, lessonId, package_id, error);
        this.logger.warn(
          `Auto-issue check failed for student ${studentId}, course ${package_id}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }
    }
  }

  /** Retries a bounded batch so failed completion events do not leave a silent certificate gap. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  public async retryPendingAutoIssuanceFailures(): Promise<void> {
    const failures = await this.autoIssuanceFailuresRepository.find({
      where: { resolved_at: IsNull(), next_retry_at: LessThanOrEqual(new Date()) },
      order: { next_retry_at: 'ASC' },
      take: 50,
    });
    for (const failure of failures) {
      try {
        // A retry queued before a full refund must never resurrect into a
        // certificate afterwards. Losing eligibility is terminal, not
        // transient, so close the failure out instead of retrying forever.
        const purchase = await this.eligibility.findActivePurchase(
          failure.student_id,
          failure.package_id,
        );
        if (!purchase) {
          failure.resolved_at = new Date();
          failure.last_error =
            'Abandoned: the student no longer holds a valid purchase for this course';
          await this.autoIssuanceFailuresRepository.save(failure);
          continue;
        }
        const progress = await this.getCourseProgress(failure.student_id, failure.package_id);
        if (progress.percentage >= 100) {
          await this.issueForCourse(failure.student_id, failure.package_id);
        }
        failure.resolved_at = new Date();
        await this.autoIssuanceFailuresRepository.save(failure);
      } catch (error) {
        await this.recordAutoIssuanceFailure(
          failure.student_id,
          failure.lesson_id,
          failure.package_id,
          error,
          failure,
        );
      }
    }
  }

  private async recordAutoIssuanceFailure(
    studentId: string,
    lessonId: string,
    packageId: string,
    error: unknown,
    current?: CertificateAutoIssuanceFailure,
  ): Promise<void> {
    const failure = current ?? (await this.autoIssuanceFailuresRepository.findOne({
      where: { student_id: studentId, lesson_id: lessonId, package_id: packageId },
    }));
    const attempts = (failure?.attempts ?? 0) + 1;
    const retryDelayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts, 7));
    await this.autoIssuanceFailuresRepository.save(
      Object.assign(
        failure ?? this.autoIssuanceFailuresRepository.create({ student_id: studentId, lesson_id: lessonId, package_id: packageId }),
        {
          attempts,
          last_error: error instanceof Error ? error.message : 'Unknown issuance error',
          next_retry_at: new Date(Date.now() + retryDelayMs),
          resolved_at: null,
        },
      ),
    );
  }

  /* ===================== Bulk issuance ===================== */

  /**
   * Issue certificates for many students of one course. Each student's
   * issuance is individually atomic and already-certified students are
   * skipped, so a bad row never rolls back the whole batch — the caller gets
   * an honest issued/skipped/failed summary instead.
   */
  public async bulkIssue(params: BulkIssueParams, teacherId?: string): Promise<BulkIssueResult> {
    const pkg = await this.packagesRepository.findOne({ where: { id: params.packageId } });
    if (!pkg) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    if (teacherId && pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody(
          'You can only issue certificates for your own courses',
          'يمكنك إصدار الشهادات لدوراتك فقط',
        ),
      );
    }
    // Validate the template once, up front, so a bad choice fails fast.
    if (params.templateId) {
      await this.resolveIssuanceTemplate(params.templateId, teacherId);
    }

    let targets: string[];
    if (params.allCompleted) {
      targets = await this.findCompletedPurchasers(params.packageId);
    } else {
      targets = [...new Set(params.studentIds ?? [])];
    }
    if (targets.length === 0) {
      throw new BadRequestException(
        biBody(
          'No matching students to issue certificates to',
          'لا يوجد طلاب مطابقون لإصدار الشهادات لهم',
        ),
      );
    }

    const result: BulkIssueResult = {
      requested: targets.length,
      issued: 0,
      skipped: 0,
      failed: [],
    };

    for (let start = 0; start < targets.length; start += BULK_ISSUE_BATCH_SIZE) {
      const batch = targets.slice(start, start + BULK_ISSUE_BATCH_SIZE);
      const outcomes = await Promise.all(
        batch.map(
          async (studentId) =>
            await this.issueBulkCertificateForStudent(studentId, params, teacherId),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status === 'issued') result.issued += 1;
        if (outcome.status === 'skipped') result.skipped += 1;
        if (outcome.status === 'failed') result.failed.push(outcome.failure);
      }
    }
    return result;
  }

  private async issueBulkCertificateForStudent(
    studentId: string,
    params: BulkIssueParams,
    teacherId?: string,
  ): Promise<
    | { status: 'issued' }
    | { status: 'skipped' }
    | { status: 'failed'; failure: { studentId: string; reason: string } }
  > {
    try {
      const existing = await this.certificatesRepository.findOne({
        where: { student_id: studentId, package_id: params.packageId },
        select: { id: true },
      });
      if (existing) return { status: 'skipped' };

      await this.issueForCourse(studentId, params.packageId, {
        ...(params.force !== undefined ? { force: params.force } : {}),
        ...(params.templateId !== undefined ? { templateId: params.templateId } : {}),
        ...(teacherId !== undefined ? { restrictTemplateOwner: teacherId } : {}),
      });
      return { status: 'issued' };
    } catch (error) {
      return {
        status: 'failed',
        failure: {
          studentId,
          reason: error instanceof Error ? error.message : 'unknown error',
        },
      };
    }
  }

  /**
   * VALID purchasers of a course who have completed every lesson in their OWN
   * purchased version. Different purchasers of the same course may now
   * legitimately have different totals (a V1 buyer's 3 lessons vs. a V2
   * buyer's 4), so the completion check is evaluated per-row against each
   * purchase's own `course_version_id`, not one shared package-wide total.
   * Refunded/revoked purchases are excluded by the canonical eligibility rule.
   */
  private async findCompletedPurchasers(packageId: string): Promise<string[]> {
    const query = this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .select('DISTINCT pp.student_id', 'student_id')
      .where('pp.package_id = :packageId', { packageId })
      .andWhere('pp.course_version_id IS NOT NULL')
      .andWhere(
        `(SELECT COUNT(*) FROM course_version_items cvi
          WHERE cvi.version_id = pp.course_version_id) > 0`,
      )
      .andWhere(
        `(SELECT COUNT(*) FROM lesson_progress lp
          INNER JOIN course_version_items cvi ON cvi.lesson_id = lp.lesson_id
          WHERE cvi.version_id = pp.course_version_id
            AND lp.student_id = pp.student_id
            AND lp.completed = true)
         >=
         (SELECT COUNT(*) FROM course_version_items cvi2
          WHERE cvi2.version_id = pp.course_version_id)`,
      );
    this.eligibility.applyActivePurchase(query, 'pp');
    const rows = await query.getRawMany<{ student_id: string }>();
    return rows.map((r) => r.student_id);
  }

  /* ===================== Revocation ===================== */

  /**
   * Revoke an issued certificate. Also forces it private so it disappears
   * from the public gallery immediately. Teachers may only revoke
   * certificates of their own courses.
   */
  public async revokeCertificate(
    id: string,
    reason?: string,
    teacherId?: string,
    actorId?: string,
  ): Promise<Certificate> {
    const certificate = await this.getManagedCertificate(id, teacherId);
    if (certificate.status === CertificateStatus.REVOKED) {
      return certificate;
    }
    certificate.status = CertificateStatus.REVOKED;
    certificate.revoked_at = new Date();
    certificate.revoke_reason = reason?.trim() || null;
    certificate.revoked_by = actorId ?? teacherId ?? null;
    certificate.revocation_context = { source: 'manual' };
    certificate.is_public = false;
    const saved = await this.certificatesRepository.save(certificate);
    // T038 (R6): reached from the marketplace enrollment-revoked LISTENER
    // (no HTTP request, so the interceptor never runs) as well as the admin/
    // teacher routes — invalidate explicitly so a just-revoked certificate
    // leaves the public gallery immediately either way.
    await this.applicationCache.invalidate(['public_catalog']);
    this.logger.log(`Certificate ${saved.certificate_number} revoked`);
    return saved;
  }

  /**
   * Reissue a revoked certificate: restores validity under FRESH credentials
   * (new number + verification code) so any copies of the revoked document
   * stay dead. The original issue-time design snapshot is preserved —
   * reissuing never restyles the certificate.
   *
   * Reissuance is an issuance path like any other, so it is subject to the
   * same canonical eligibility rule (DEF-019): a certificate revoked because
   * the course was refunded cannot be brought back to life while the purchase
   * stays revoked.
   */
  public async reissueCertificate(
    id: string,
    teacherId?: string,
    actorId?: string,
  ): Promise<Certificate> {
    const certificate = await this.getManagedCertificate(id, teacherId);
    if (certificate.status !== CertificateStatus.REVOKED) {
      throw new BadRequestException(
        biBody('Only a revoked certificate can be reissued', 'لا يمكن إعادة إصدار إلا شهادة ملغاة'),
      );
    }
    const packageId = certificate.package_id;
    if (packageId === null) {
      // A marketplace certificate never reaches this path — its own
      // MarketplaceCertificateIssuanceService owns reissue (if any), reading
      // solely marketplace-owned eligibility data (FR-324).
      throw new BadRequestException(
        biBody('This certificate is not an academic certificate', 'هذه الشهادة ليست شهادة أكاديمية'),
      );
    }
    await this.eligibility.assertEligible(certificate.student_id, packageId);
    await this.certificateHistoryRepository.save(
      this.certificateHistoryRepository.create({
        certificate_id: certificate.id,
        certificate_number: certificate.certificate_number,
        verification_code: certificate.verification_code,
        status: certificate.status,
        revoked_at: certificate.revoked_at,
        revoke_reason: certificate.revoke_reason,
        revocation_context: certificate.revocation_context,
        reissued_by: actorId ?? teacherId ?? null,
      }),
    );
    certificate.certificate_number = await this.uniqueNumber();
    certificate.verification_code = await this.uniqueCode();
    certificate.status = CertificateStatus.ISSUED;
    certificate.issued_at = new Date();
    certificate.revoked_at = null;
    certificate.revoke_reason = null;
    certificate.revoked_by = null;
    certificate.revocation_context = null;
    const saved = await this.certificatesRepository.save(certificate);
    this.logger.log(`Certificate reissued as ${saved.certificate_number}`);
    this.eventEmitter.emit(CERTIFICATE_ISSUED_EVENT, {
      certificateId: saved.id,
      studentId: saved.student_id,
      packageId,
    } satisfies CertificateIssuedEvent);
    return saved;
  }

  /**
   * FR-324, FR-248. The certificates table's marketplace write path — the
   * only one, mirroring `issueForCourse()`'s own shape (idempotency
   * pre-check, re-check inside a locked transaction, unique-violation race
   * caught and the winner returned) so both subjects share one set of
   * "never a duplicate certificate" guarantees. Takes plain, already-
   * resolved values rather than a `marketplaceCourseId` it would look up
   * itself — the caller (`MarketplaceCertificateIssuanceService`) is the
   * one that determined eligibility from marketplace-owned data (FR-324
   * forbids this method, which lives in the always-loaded academic core,
   * from reading any marketplace table itself). Reuses the exact template
   * resolution, code generation and snapshot logic `issueForCourse()` uses
   * — always the platform default template; marketplace instructors do not
   * (yet) have their own certificate template ownership, unlike teachers.
   * Emits the same `CERTIFICATE_ISSUED_EVENT` `CertificateNotificationListener`
   * already reacts to (it only re-reads the saved row, never `packageId`),
   * so the "certificate ready" notification is reused for free rather than
   * re-implemented for marketplace.
   */
  public async issueMarketplaceCertificate(input: MarketplaceCertificateInput): Promise<Certificate> {
    const existing = await this.certificatesRepository.findOne({
      where: { student_id: input.studentId, marketplace_course_id: input.marketplaceCourseId },
    });
    if (existing) return existing;

    let certificate: Certificate;
    let created: boolean;
    try {
      ({ certificate, created } = await this.dataSource.transaction<{ certificate: Certificate; created: boolean }>(
        async (manager) => {
          const raced = await manager.findOne(Certificate, {
            where: { student_id: input.studentId, marketplace_course_id: input.marketplaceCourseId },
          });
          if (raced) return { certificate: raced, created: false };

          const template = await this.findDefaultTemplate();
          this.assertTemplateCanBeIssued(template);

          const record = manager.create(Certificate, {
            certificate_number: await this.uniqueNumber(),
            verification_code: await this.uniqueCode(),
            student_id: input.studentId,
            package_id: null,
            marketplace_course_id: input.marketplaceCourseId,
            source: 'marketplace',
            student_name: input.studentName,
            course_title: input.courseTitle,
            teacher_name: input.instructorName,
            completion_percentage: 100,
            template_id: template?.id ?? null,
            template_snapshot: this.snapshotOf(template),
            status: CertificateStatus.ISSUED,
            revoked_at: null,
            revoke_reason: null,
            revoked_by: null,
            revocation_context: null,
            issued_at: new Date(),
          });
          const saved = await manager.save(Certificate, record);
          this.logger.log(
            `Marketplace certificate ${saved.certificate_number} issued to student ${input.studentId} for course ${input.marketplaceCourseId}`,
          );
          return { certificate: saved, created: true };
        },
      ));
    } catch (error) {
      if (error instanceof QueryFailedError && (error as unknown as { code?: string }).code === '23505') {
        const raced = await this.certificatesRepository.findOne({
          where: { student_id: input.studentId, marketplace_course_id: input.marketplaceCourseId },
        });
        if (raced) return raced;
      }
      throw error;
    }

    if (created) {
      this.eventEmitter.emit(CERTIFICATE_ISSUED_EVENT, {
        certificateId: certificate.id,
        studentId: certificate.student_id,
        packageId: null,
      } satisfies CertificateIssuedEvent);
    }
    return certificate;
  }

  /** Read-only lookup for the marketplace revocation trigger (T127) — never throws; a missing certificate is simply nothing to revoke. */
  public async getMarketplaceCertificateForCourse(studentId: string, marketplaceCourseId: string): Promise<Certificate | null> {
    return this.certificatesRepository.findOne({ where: { student_id: studentId, marketplace_course_id: marketplaceCourseId } });
  }

  /** Read an issued certificate, asserting teacher course-ownership when scoped. */
  public getManagedCertificateForTeacher(id: string, teacherId?: string): Promise<Certificate> {
    return this.getManagedCertificate(id, teacherId);
  }

  /** Load a certificate, asserting teacher course-ownership when scoped. */
  private async getManagedCertificate(id: string, teacherId?: string): Promise<Certificate> {
    const certificate = await this.certificatesRepository.findOne({ where: { id } });
    if (!certificate) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    if (teacherId) {
      // A marketplace certificate (package_id null) has no academic teacher
      // to own it through this path — treat exactly like a mismatched owner.
      const pkg = certificate.package_id
        ? await this.packagesRepository.findOne({
            where: { id: certificate.package_id },
            select: { id: true, teacher_id: true },
          })
        : null;
      if (!pkg || pkg.teacher_id !== teacherId) {
        throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
      }
    }
    return certificate;
  }

  /* ===================== Visibility & public gallery ===================== */

  /** Student-controlled gallery visibility; only valid certificates can go public. */
  public async setVisibility(
    id: string,
    studentId: string,
    isPublic: boolean,
  ): Promise<Certificate> {
    const certificate = await this.getOwnedCertificate(id, studentId);
    if (isPublic && certificate.status !== CertificateStatus.ISSUED) {
      throw new BadRequestException(
        biBody('A revoked certificate cannot be made public', 'لا يمكن جعل شهادة ملغاة عامة'),
      );
    }
    certificate.is_public = isPublic;
    return this.certificatesRepository.save(certificate);
  }

  /**
   * The public achievements gallery: only certificates their owners chose to
   * publish, and only while still valid. Returns a sanitized projection —
   * the DB id, student id, and grades never leave the server.
   *
   * Cached (T038, W1-C6 d), `public_catalog`/`public`, 60 s TTL. Privacy-
   * sensitive: revoke/reissue (`revokeCertificate`) and the visibility toggle
   * (`setVisibility`) reach this via the interceptor's global invalidateAll()
   * fallback (neither route declares `@InvalidatesCache`); the non-HTTP
   * revoke path (`CertificateEligibilityService.revokeForWithdrawnAccess`,
   * reachable from refund crons with no HTTP request) invalidates explicitly
   * — see that method. No rule-7 TTL-drift exception was needed.
   */
  public async getPublicCertificates(options: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedList<PublicCertificateCard>> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'certificates.public',
        scope: 'public',
        parts: [options.page ?? 1, options.limit ?? 12, (options.search ?? '').trim().toLowerCase()],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computePublicCertificates(options),
    );
  }

  private async computePublicCertificates(options: {
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<PaginatedList<PublicCertificateCard>> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 50) : 12;

    const qb = this.certificatesRepository
      .createQueryBuilder('c')
      .where('c.is_public = true')
      .andWhere('c.status = :status', { status: CertificateStatus.ISSUED });

    if (options.search?.trim()) {
      qb.andWhere(
        '(c.student_name ILIKE :search OR c.course_title ILIKE :search OR c.certificate_number ILIKE :search)',
        { search: `%${options.search.trim()}%` },
      );
    }

    const [rows, total] = await qb
      .orderBy('c.issued_at', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);
    return {
      data: rows.map((c) => ({
        publicId: c.verification_code,
        certificate_number: c.certificate_number,
        student_name: c.student_name,
        course_title: c.course_title,
        teacher_name: c.teacher_name,
        issued_at: c.issued_at,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /**
   * Management listing for admins (all) and teachers (own courses only).
   */
  public async listCertificates(
    options: { page?: number; limit?: number; search?: string; status?: CertificateStatus },
    teacherId?: string,
  ): Promise<PaginatedList<Certificate>> {
    const page = options.page && options.page > 0 ? options.page : 1;
    const limit = options.limit && options.limit > 0 ? Math.min(options.limit, 100) : 20;

    const qb = this.certificatesRepository.createQueryBuilder('c');
    if (teacherId) {
      qb.innerJoin('lesson_packages', 'pkg', 'pkg.id = c.package_id').andWhere(
        'pkg.teacher_id = :teacherId',
        { teacherId },
      );
    }
    if (options.status) {
      qb.andWhere('c.status = :status', { status: options.status });
    }
    if (options.search?.trim()) {
      qb.andWhere(
        '(c.student_name ILIKE :search OR c.course_title ILIKE :search OR c.certificate_number ILIKE :search)',
        { search: `%${options.search.trim()}%` },
      );
    }

    const [data, total] = await qb
      .orderBy('c.issued_at', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  /* ===================== Reads ===================== */

  public async getMyCertificates(
    studentId: string,
    page: number,
    limit: number,
    source?: CertificateSource,
  ): Promise<{ data: Certificate[]; meta: PaginationMeta }> {
    const [data, total] = await this.certificatesRepository.findAndCount({
      where: source ? { student_id: studentId, source } : { student_id: studentId },
      order: { issued_at: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  public async getOwnedCertificate(id: string, studentId: string): Promise<Certificate> {
    const certificate = await this.certificatesRepository.findOne({
      where: { id, student_id: studentId },
    });
    if (!certificate) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    return certificate;
  }

  /**
   * The student's own download. A revoked certificate stays VISIBLE in their
   * list (with its revoked state) but is never rendered as a document —
   * otherwise a fully refunded student could still produce a clean,
   * valid-looking PDF and pass it off as proof (DEF-019). Admin/teacher
   * previews are deliberately unaffected: support and audit need to see the
   * historical document.
   */
  public async getOwnedDownloadableCertificate(
    id: string,
    studentId: string,
  ): Promise<Certificate> {
    const certificate = await this.getOwnedCertificate(id, studentId);
    if (certificate.status !== CertificateStatus.ISSUED) {
      throw new BadRequestException(
        biBody(
          'This certificate has been revoked and can no longer be downloaded.',
          'تم إلغاء هذه الشهادة ولم يعد بالإمكان تنزيلها.',
        ),
      );
    }
    return certificate;
  }

  /** Public verification by code — returns the certificate (any status). */
  public async getByVerificationCode(code: string): Promise<Certificate> {
    const certificate = await this.certificatesRepository.findOne({
      where: { verification_code: code },
    });
    if (!certificate) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    return certificate;
  }

  /**
   * A downloadable public document is available only while the certificate is
   * valid. A revoked certificate — including one revoked by a full refund —
   * is never rendered as a document, so it can never be presented as proof.
   */
  public async getVerifiedCertificateByCode(code: string): Promise<Certificate> {
    const certificate = await this.getByVerificationCode(code);
    if (certificate.status !== CertificateStatus.ISSUED) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    return certificate;
  }

  /* ===================== PDF ===================== */

  public async renderPdf(
    certificate: Certificate,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<Buffer> {
    return this.pdfService.render(
      certificate,
      await this.getRenderableTemplateSnapshot(certificate),
      locale,
    );
  }

  /**
   * The canonical design data for an issued certificate. New certificates
   * always return their frozen issue-time snapshot. The live-template lookup
   * remains only as a backward-compatible rendering strategy for legacy rows.
   */
  public async getRenderableTemplateSnapshot(
    certificate: Certificate,
  ): Promise<CertificateTemplateSnapshot | null> {
    if (certificate.template_snapshot) return certificate.template_snapshot;
    const template = certificate.template_id
      ? await this.templatesRepository.findOne({ where: { id: certificate.template_id } })
      : await this.findDefaultTemplate();
    return template ? this.snapshotOf(template) : null;
  }

  /**
   * Render a sample certificate from an UNSAVED template design so the builder
   * can show a pixel-accurate "what the PDF will actually look like" preview.
   * Nothing is persisted.
   */
  public renderTemplateSample(
    dto: CertificatePreviewDto,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<Buffer> {
    const design = this.sanitizeTemplateDto(dto);
    this.assertTemplatePlaceholders({
      body: design.body ?? '',
      body_ar: design.body_ar ?? null,
    });
    const sample = this.certificatesRepository.create({
      certificate_number: 'CERT-PREVIEW',
      verification_code: 'PREVIEW',
      student_name: locale === PreferredLanguage.AR ? 'اسم الطالب' : 'Student Name',
      course_title: locale === PreferredLanguage.AR ? 'اسم الكورس' : 'Course Name',
      teacher_name: locale === PreferredLanguage.AR ? 'اسم المعلم' : 'Instructor Name',
      completion_percentage: 100,
      status: CertificateStatus.ISSUED,
      issued_at: new Date(),
    });
    sample.student_name = dto.sample_student_name?.trim() || sample.student_name;
    sample.course_title = dto.sample_course_title?.trim() || sample.course_title;
    sample.teacher_name = dto.sample_teacher_name?.trim() || sample.teacher_name;
    if (dto.sample_issue_date) sample.issued_at = new Date(dto.sample_issue_date);
    return this.pdfService.render(
      sample,
      {
        title: design.title ?? 'Certificate of Completion',
        title_ar: design.title_ar ?? null,
        body:
          design.body ??
          'This is proudly presented to {{student}} for successfully completing {{course}}.',
        body_ar: design.body_ar ?? null,
        signature_name: design.signature_name ?? null,
        signature_title: design.signature_title ?? null,
        signature_title_ar: design.signature_title_ar ?? null,
        accent_color: design.accent_color ?? '#6d28d9',
        layout: design.layout ?? 'classic',
        font: design.font ?? 'sans',
        title_font_size: design.title_font_size ?? 34,
        body_font_size: design.body_font_size ?? 16,
        text_alignment: design.text_alignment ?? 'center',
      },
      locale,
    );
  }

  /**
   * Teacher preview: render a sample certificate for one of the teacher's own
   * courses without persisting anything.
   */
  public async previewForTeacher(
    teacherId: string,
    packageId: string,
    sampleName = 'Student Name',
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<Buffer> {
    const pkg = await this.packagesRepository.findOne({
      where: { id: packageId },
      relations: ['teacher'],
    });
    if (!pkg) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    if (pkg.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only preview your own courses', 'يمكنك معاينة دوراتك الخاصة فقط'),
      );
    }

    const template = await this.findDefaultTemplate();
    const sample = this.certificatesRepository.create({
      certificate_number: 'CERT-PREVIEW',
      verification_code: 'PREVIEW',
      student_name: sampleName,
      course_title: pkg.title,
      teacher_name: pkg.teacher?.name ?? null,
      completion_percentage: 100,
      status: CertificateStatus.ISSUED,
      issued_at: new Date(),
    });
    return this.pdfService.render(sample, template, locale);
  }

  /* ===================== Analytics ===================== */

  public async getAnalytics(teacherId?: string): Promise<{
    total: number;
    thisMonth: number;
    topCourses: { packageId: string; title: string; count: number }[];
  }> {
    // FR-252: academic figures never include a marketplace-sourced row.
    // The teacher-scoped branch already excludes them structurally (the
    // INNER JOIN to lesson_packages never matches a NULL package_id), but
    // the admin-wide branch has no such join — filtered explicitly here so
    // both paths state the same invariant rather than one relying on an
    // incidental join side effect.
    const base = this.certificatesRepository.createQueryBuilder('c').where("c.source = 'academic'");
    if (teacherId) {
      base.innerJoin('lesson_packages', 'pkg', 'pkg.id = c.package_id').andWhere('pkg.teacher_id = :teacherId', { teacherId });
    }

    const total = await base.getCount();

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const thisMonthQb = this.certificatesRepository
      .createQueryBuilder('c')
      .where("c.source = 'academic'")
      .andWhere('c.issued_at >= :monthStart', { monthStart });
    if (teacherId) {
      thisMonthQb
        .innerJoin('lesson_packages', 'pkg', 'pkg.id = c.package_id')
        .andWhere('pkg.teacher_id = :teacherId', { teacherId });
    }
    const thisMonth = await thisMonthQb.getCount();

    const topQb = this.certificatesRepository
      .createQueryBuilder('c')
      .innerJoin('lesson_packages', 'pkg', 'pkg.id = c.package_id')
      .select('c.package_id', 'packageId')
      .addSelect('MAX(pkg.title)', 'title')
      .addSelect('COUNT(*)', 'count')
      .groupBy('c.package_id')
      .orderBy('count', 'DESC')
      .limit(10);
    if (teacherId) {
      topQb.where('pkg.teacher_id = :teacherId', { teacherId });
    }
    const topRows = await topQb.getRawMany<{
      packageId: string;
      title: string;
      count: string;
    }>();

    return {
      total,
      thisMonth,
      topCourses: topRows.map((r) => ({
        packageId: r.packageId,
        title: r.title,
        count: Number.parseInt(r.count, 10),
      })),
    };
  }

  /* ===================== Templates ===================== */

  /**
   * Templates with per-template issued-certificate counts (one grouped query,
   * no N+1). Teachers see their own templates; admins see all.
   */
  public async getTemplates(
    ownerId?: string,
  ): Promise<(CertificateTemplate & { issued_count: number })[]> {
    const templates = await this.templatesRepository.find({
      ...(ownerId ? { where: { owner_id: ownerId } } : {}),
      order: { created_at: 'DESC', id: 'DESC' },
      take: 100,
    });
    if (templates.length === 0) return [];

    const counts = await this.certificatesRepository
      .createQueryBuilder('c')
      .select('c.template_id', 'template_id')
      .addSelect('COUNT(*)', 'count')
      .where('c.template_id IN (:...ids)', { ids: templates.map((t) => t.id) })
      .groupBy('c.template_id')
      .getRawMany<{ template_id: string; count: string }>();
    const countById = new Map(counts.map((r) => [r.template_id, Number.parseInt(r.count, 10)]));

    return templates.map((template) =>
      Object.assign(template, { issued_count: countById.get(template.id) ?? 0 }),
    );
  }

  /** Published platform designs plus the teacher's own published designs. */
  public async getIssuableTemplates(
    ownerId: string,
  ): Promise<(CertificateTemplate & { issued_count: number })[]> {
    const templates = await this.templatesRepository.find({
      where: [
        { owner_id: ownerId, status: CertificateTemplateStatus.PUBLISHED },
        { owner_id: IsNull(), status: CertificateTemplateStatus.PUBLISHED },
      ],
      order: { created_at: 'DESC', id: 'DESC' },
      take: 100,
    });
    if (templates.length === 0) return [];

    const counts = await this.certificatesRepository
      .createQueryBuilder('c')
      .select('c.template_id', 'template_id')
      .addSelect('COUNT(*)', 'count')
      .where('c.template_id IN (:...ids)', { ids: templates.map((template) => template.id) })
      .groupBy('c.template_id')
      .getRawMany<{ template_id: string; count: string }>();
    const countById = new Map(
      counts.map((row) => [row.template_id, Number.parseInt(row.count, 10)]),
    );

    return templates.map((template) =>
      Object.assign(template, { issued_count: countById.get(template.id) ?? 0 }),
    );
  }

  public async getTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.templatesRepository.findOne({
      where: ownerId ? { id, owner_id: ownerId } : { id },
    });
    if (!template) {
      throw new NotFoundException(biBody('Template not found', 'القالب غير موجود'));
    }
    return template;
  }

  /** New templates always start as DRAFTS — publishing is a separate action. */
  public async createTemplate(
    dto: CreateTemplateDto,
    ownerId?: string,
  ): Promise<CertificateTemplate> {
    const sanitized = this.sanitizeTemplateDto(dto);
    const template = this.templatesRepository.create({
      ...sanitized,
      owner_id: ownerId ?? null,
      status: CertificateTemplateStatus.DRAFT,
      is_default: false,
    });
    return this.templatesRepository.save(template);
  }

  public async updateTemplate(
    id: string,
    dto: UpdateTemplateDto,
    ownerId?: string,
  ): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);
    Object.assign(template, this.sanitizeTemplateDto(dto));
    if (template.status === CertificateTemplateStatus.PUBLISHED) {
      this.assertTemplateCanBeIssued(template);
    }
    const saved = await this.templatesRepository.save(template);
    if (saved.is_default) {
      await this.unsetOtherDefaults(saved.id, saved.owner_id);
    }
    return saved;
  }

  /**
   * Publish a draft: validates the design is complete, then makes it available
   * for issuance. A teacher's freshly published design becomes their
   * auto-issue default (platform/admin templates stay opt-in defaults).
   * Publishing NEVER creates a certificate — it only unlocks the design.
   */
  public async publishTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);

    this.assertTemplatePlaceholders(template);

    const missing: string[] = [];
    if (!template.name?.trim()) missing.push('name');
    if (!template.title?.trim()) missing.push('title');
    if (!template.body?.trim()) missing.push('body');
    if (missing.length > 0) {
      throw new BadRequestException(
        biBody(
          `Cannot publish — missing required fields: ${missing.join(', ')}`,
          `لا يمكن النشر — حقول مطلوبة ناقصة: ${missing.join('، ')}`,
        ),
      );
    }

    template.status = CertificateTemplateStatus.PUBLISHED;
    if (template.owner_id) {
      template.is_default = true;
    }
    const saved = await this.templatesRepository.save(template);
    if (saved.is_default) {
      await this.unsetOtherDefaults(saved.id, saved.owner_id);
    }
    return saved;
  }

  /** Back to draft: hidden from issuance again, freely editable. */
  public async unpublishTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);
    template.status = CertificateTemplateStatus.DRAFT;
    template.is_default = false;
    return this.templatesRepository.save(template);
  }

  /** Archived templates can never be used for new issuance. */
  public async archiveTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);
    template.status = CertificateTemplateStatus.ARCHIVED;
    template.is_default = false;
    return this.templatesRepository.save(template);
  }

  /** Copy an existing design into a fresh draft owned by the caller. */
  public async duplicateTemplate(
    id: string,
    ownerId?: string,
    callerOwnerId?: string,
  ): Promise<CertificateTemplate> {
    const source = await this.getTemplate(id, ownerId);
    const copy = this.templatesRepository.create({
      name: `${source.name} (copy)`.slice(0, 120),
      title: source.title,
      title_ar: source.title_ar,
      body: source.body,
      body_ar: source.body_ar,
      signature_name: source.signature_name,
      signature_title: source.signature_title,
      signature_title_ar: source.signature_title_ar,
      accent_color: source.accent_color,
      layout: source.layout,
      font: source.font,
      title_font_size: source.title_font_size,
      body_font_size: source.body_font_size,
      text_alignment: source.text_alignment,
      owner_id: callerOwnerId ?? source.owner_id ?? null,
      status: CertificateTemplateStatus.DRAFT,
      is_default: false,
    });
    return this.templatesRepository.save(copy);
  }

  public async deleteTemplate(id: string, ownerId?: string): Promise<void> {
    const template = await this.getTemplate(id, ownerId);
    await this.templatesRepository.remove(template);
  }

  /* ===================== Helpers ===================== */

  /** Only PUBLISHED templates may be used as an auto-issue default. */
  private findDefaultTemplate(ownerId?: string): Promise<CertificateTemplate | null> {
    return this.templatesRepository.findOne({
      where: ownerId
        ? { is_default: true, owner_id: ownerId, status: CertificateTemplateStatus.PUBLISHED }
        : { is_default: true, owner_id: IsNull(), status: CertificateTemplateStatus.PUBLISHED },
    });
  }

  /**
   * Validate an explicitly chosen issuance template: it must exist, be
   * PUBLISHED (never a draft or archived design), and — when the issuer is a
   * teacher — be either a platform template or the teacher's own.
   */
  private async resolveIssuanceTemplate(
    templateId: string,
    restrictToOwner?: string,
  ): Promise<CertificateTemplate> {
    const template = await this.getTemplate(templateId);
    if (template.status !== CertificateTemplateStatus.PUBLISHED) {
      throw new BadRequestException(
        biBody(
          'Only published templates can be used to issue certificates',
          'لا يمكن إصدار الشهادات إلا باستخدام قوالب منشورة',
        ),
      );
    }
    if (restrictToOwner && template.owner_id !== null && template.owner_id !== restrictToOwner) {
      throw new ForbiddenException(
        biBody(
          'You can only use your own or platform templates',
          'يمكنك استخدام قوالبك أو قوالب المنصة فقط',
        ),
      );
    }
    return template;
  }

  /** Published designs are executable certificate content, not free-form copy. */
  private assertTemplateCanBeIssued(template: CertificateTemplate | null): void {
    if (!template) return;
    const missing = [
      !template.name?.trim() ? 'name' : null,
      !template.title?.trim() ? 'title' : null,
      !template.body?.trim() ? 'body' : null,
    ].filter((field): field is string => field !== null);
    if (missing.length > 0) {
      throw new BadRequestException(`Certificate template is incomplete: ${missing.join(', ')}`);
    }
    this.assertTemplatePlaceholders(template);
  }

  /** Reject unsupported placeholders before they are frozen into a certificate. */
  private assertTemplatePlaceholders(
    template: Pick<CertificateTemplate, 'body' | 'body_ar'>,
  ): void {
    const supported = new Set(['student', 'course', 'date']);
    const unsupported = new Set<string>();
    for (const value of [template.body, template.body_ar]) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const token = match[1]?.trim().toLowerCase();
        if (token && !supported.has(token)) unsupported.add(`{{${token}}}`);
      }
    }
    if (unsupported.size > 0) {
      throw new UnprocessableEntityException(
        `Unsupported certificate placeholders: ${[...unsupported].join(', ')}. Use {{student}}, {{course}}, or {{date}}.`,
      );
    }
  }

  private snapshotOf(template: CertificateTemplate | null): CertificateTemplateSnapshot | null {
    if (!template) return null;
    return {
      title: template.title,
      title_ar: template.title_ar,
      body: template.body,
      body_ar: template.body_ar,
      signature_name: template.signature_name,
      signature_title: template.signature_title,
      signature_title_ar: template.signature_title_ar,
      accent_color: template.accent_color,
      layout: template.layout,
      font: template.font,
      title_font_size: template.title_font_size,
      body_font_size: template.body_font_size,
      text_alignment: template.text_alignment,
    };
  }

  private async unsetOtherDefaults(keepId: string, ownerId: string | null): Promise<void> {
    const query = this.templatesRepository
      .createQueryBuilder()
      .update()
      .set({ is_default: false })
      .where('id != :keepId', { keepId })
      .andWhere('is_default = true');
    if (ownerId) {
      query.andWhere('owner_id = :ownerId', { ownerId });
    } else {
      query.andWhere('owner_id IS NULL');
    }
    await query.execute();
  }

  /** Text is rendered as escaped text in React/PDFKit; never accept markup. */
  private sanitizeTemplateDto<T extends CreateTemplateDto | UpdateTemplateDto>(dto: T): T {
    const sanitized = { ...dto } as Record<string, unknown>;
    for (const [key, value] of Object.entries(sanitized)) {
      // Validation DTO instances can carry every optional field as an own
      // `undefined` property. Leaving those values in a PATCH would erase the
      // published template's required name/body before it is snapshotted.
      if (value === undefined) {
        delete sanitized[key];
        continue;
      }
      if (typeof value === 'string') {
        sanitized[key] = value
          .replace(/[<>]/g, '')
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
          .trim();
      }
    }
    return sanitized as T;
  }

  private async uniqueNumber(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = generateCertificateNumber();
      const exists = await this.certificatesRepository.findOne({
        where: { certificate_number: candidate },
        select: { id: true },
      });
      if (!exists) {
        return candidate;
      }
    }
    throw new Error('Could not generate a unique certificate number');
  }

  private async uniqueCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const candidate = generateVerificationCode();
      const exists = await this.certificatesRepository.findOne({
        where: { verification_code: candidate },
        select: { id: true },
      });
      if (!exists) {
        return candidate;
      }
    }
    throw new Error('Could not generate a unique verification code');
  }
}
