import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../packages/entities/lesson-package-item.entity';
import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { biBody } from '../i18n/error-translator.util';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { User } from '../users/entities/user.entity';
import { generateCertificateNumber, generateVerificationCode } from './certificate-code.util';
import { CertificatePdfService } from './certificate-pdf.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import type { CertificateTemplateSnapshot } from './entities/certificate.entity';
import { Certificate } from './entities/certificate.entity';
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
  packageId: string;
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

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    @InjectRepository(Certificate)
    private readonly certificatesRepository: Repository<Certificate>,
    @InjectRepository(CertificateTemplate)
    private readonly templatesRepository: Repository<CertificateTemplate>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    @InjectRepository(LessonPackageItem)
    private readonly packageItemsRepository: Repository<LessonPackageItem>,
    @InjectRepository(LessonProgress)
    private readonly progressRepository: Repository<LessonProgress>,
    @InjectRepository(PackagePurchase)
    private readonly packagePurchasesRepository: Repository<PackagePurchase>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly pdfService: CertificatePdfService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /* ===================== Completion ===================== */

  /** How much of a course (package) a student has completed. */
  public async getCourseProgress(studentId: string, packageId: string): Promise<CourseProgress> {
    const total = await this.packageItemsRepository.count({
      where: { package_id: packageId },
    });
    if (total === 0) {
      return { total: 0, completed: 0, percentage: 0 };
    }

    const completed = await this.progressRepository
      .createQueryBuilder('lp')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.lesson_id = lp.lesson_id')
      .where('lpi.package_id = :packageId', { packageId })
      .andWhere('lp.student_id = :studentId', { studentId })
      .andWhere('lp.completed = true')
      .getCount();

    const percentage = Math.round((completed / total) * 100);
    return { total, completed, percentage };
  }

  /* ===================== Issuance ===================== */

  /**
   * Issue (or return the existing) certificate for a completed course.
   * Idempotent per (student, package). Throws if the course isn't fully
   * completed unless `force` is set (admin override).
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
      return existing;
    }

    const progress = await this.getCourseProgress(studentId, packageId);
    if (progress.total === 0) {
      throw new BadRequestException(
        biBody('This course has no lessons to complete.', 'لا تحتوي هذه الدورة على دروس لإكمالها.'),
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
      this.usersRepository.findOne({ where: { id: studentId } }),
      this.packagesRepository.findOne({
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
      : ((await this.findDefaultTemplate(pkg.teacher_id)) ?? (await this.findDefaultTemplate()));

    const certificate = this.certificatesRepository.create({
      certificate_number: await this.uniqueNumber(),
      verification_code: await this.uniqueCode(),
      student_id: studentId,
      package_id: packageId,
      student_name: student.name,
      course_title: pkg.title,
      teacher_name: pkg.teacher?.name ?? null,
      completion_percentage: progress.percentage,
      template_id: template?.id ?? null,
      // Freeze the design NOW — later template edits must never restyle this
      // certificate.
      template_snapshot: this.snapshotOf(template),
      status: CertificateStatus.ISSUED,
      issued_at: new Date(),
    });

    const saved = await this.certificatesRepository.save(certificate);
    this.logger.log(
      `Certificate ${saved.certificate_number} issued to student ${studentId} for course ${packageId}`,
    );
    this.eventEmitter.emit(CERTIFICATE_ISSUED_EVENT, {
      certificateId: saved.id,
      studentId,
      packageId,
    });
    return saved;
  }

  /**
   * Auto-issue for every purchased course that contains the completed lesson and
   * is now fully complete. Best-effort: a failure on one course is logged and
   * does not block the others.
   */
  public async autoIssueForCompletedLesson(studentId: string, lessonId: string): Promise<void> {
    const rows = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .innerJoin('lesson_package_items', 'lpi', 'lpi.package_id = pp.package_id')
      .where('pp.student_id = :studentId', { studentId })
      .andWhere('lpi.lesson_id = :lessonId', { lessonId })
      .select('DISTINCT pp.package_id', 'package_id')
      .getRawMany<{ package_id: string }>();

    for (const { package_id } of rows) {
      try {
        const progress = await this.getCourseProgress(studentId, package_id);
        if (progress.percentage >= 100) {
          await this.issueForCourse(studentId, package_id);
        }
      } catch (error) {
        this.logger.warn(
          `Auto-issue check failed for student ${studentId}, course ${package_id}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }
    }
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
        biBody('You can only issue certificates for your own courses', 'يمكنك إصدار الشهادات لدوراتك فقط'),
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
        biBody('No matching students to issue certificates to', 'لا يوجد طلاب مطابقون لإصدار الشهادات لهم'),
      );
    }

    const result: BulkIssueResult = {
      requested: targets.length,
      issued: 0,
      skipped: 0,
      failed: [],
    };

    for (const studentId of targets) {
      try {
        const existing = await this.certificatesRepository.findOne({
          where: { student_id: studentId, package_id: params.packageId },
          select: { id: true },
        });
        if (existing) {
          result.skipped += 1;
          continue;
        }
        await this.issueForCourse(studentId, params.packageId, {
          ...(params.force !== undefined ? { force: params.force } : {}),
          ...(params.templateId !== undefined ? { templateId: params.templateId } : {}),
          ...(teacherId !== undefined ? { restrictTemplateOwner: teacherId } : {}),
        });
        result.issued += 1;
      } catch (error) {
        result.failed.push({
          studentId,
          reason: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }
    return result;
  }

  /** Purchasers of a course who have completed every lesson in it. */
  private async findCompletedPurchasers(packageId: string): Promise<string[]> {
    const total = await this.packageItemsRepository.count({ where: { package_id: packageId } });
    if (total === 0) return [];
    const rows = await this.packagePurchasesRepository
      .createQueryBuilder('pp')
      .select('DISTINCT pp.student_id', 'student_id')
      .where('pp.package_id = :packageId', { packageId })
      .andWhere(
        `(SELECT COUNT(*) FROM lesson_progress lp
          INNER JOIN lesson_package_items lpi ON lpi.lesson_id = lp.lesson_id
          WHERE lpi.package_id = :packageId
            AND lp.student_id = pp.student_id
            AND lp.completed = true) >= :total`,
        { packageId, total },
      )
      .getRawMany<{ student_id: string }>();
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
  ): Promise<Certificate> {
    const certificate = await this.getManagedCertificate(id, teacherId);
    if (certificate.status === CertificateStatus.REVOKED) {
      throw new BadRequestException(
        biBody('Certificate is already revoked', 'الشهادة ملغاة بالفعل'),
      );
    }
    certificate.status = CertificateStatus.REVOKED;
    certificate.revoked_at = new Date();
    certificate.revoke_reason = reason?.trim() || null;
    certificate.is_public = false;
    const saved = await this.certificatesRepository.save(certificate);
    this.logger.log(`Certificate ${saved.certificate_number} revoked`);
    return saved;
  }

  /**
   * Reissue a revoked certificate: restores validity under FRESH credentials
   * (new number + verification code) so any copies of the revoked document
   * stay dead. The original issue-time design snapshot is preserved —
   * reissuing never restyles the certificate.
   */
  public async reissueCertificate(id: string, teacherId?: string): Promise<Certificate> {
    const certificate = await this.getManagedCertificate(id, teacherId);
    if (certificate.status !== CertificateStatus.REVOKED) {
      throw new BadRequestException(
        biBody('Only a revoked certificate can be reissued', 'لا يمكن إعادة إصدار إلا شهادة ملغاة'),
      );
    }
    certificate.certificate_number = await this.uniqueNumber();
    certificate.verification_code = await this.uniqueCode();
    certificate.status = CertificateStatus.ISSUED;
    certificate.issued_at = new Date();
    certificate.revoked_at = null;
    certificate.revoke_reason = null;
    const saved = await this.certificatesRepository.save(certificate);
    this.logger.log(`Certificate reissued as ${saved.certificate_number}`);
    this.eventEmitter.emit(CERTIFICATE_ISSUED_EVENT, {
      certificateId: saved.id,
      studentId: saved.student_id,
      packageId: saved.package_id,
    } satisfies CertificateIssuedEvent);
    return saved;
  }

  /** Load a certificate, asserting teacher course-ownership when scoped. */
  private async getManagedCertificate(id: string, teacherId?: string): Promise<Certificate> {
    const certificate = await this.certificatesRepository.findOne({ where: { id } });
    if (!certificate) {
      throw new NotFoundException(biBody('Certificate not found', 'الشهادة غير موجودة'));
    }
    if (teacherId) {
      const pkg = await this.packagesRepository.findOne({
        where: { id: certificate.package_id },
        select: { id: true, teacher_id: true },
      });
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
   */
  public async getPublicCertificates(options: {
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
  ): Promise<{ data: Certificate[]; meta: PaginationMeta }> {
    const [data, total] = await this.certificatesRepository.findAndCount({
      where: { student_id: studentId },
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

  /* ===================== PDF ===================== */

  public async renderPdf(
    certificate: Certificate,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<Buffer> {
    // The frozen issue-time design always wins; live-template lookup only
    // remains for legacy certificates issued before snapshots existed.
    if (certificate.template_snapshot) {
      return this.pdfService.render(certificate, certificate.template_snapshot, locale);
    }
    const template = certificate.template_id
      ? await this.templatesRepository.findOne({
          where: { id: certificate.template_id },
        })
      : await this.findDefaultTemplate();
    return this.pdfService.render(certificate, template, locale);
  }

  /**
   * Render a sample certificate from an UNSAVED template design so the builder
   * can show a pixel-accurate "what the PDF will actually look like" preview.
   * Nothing is persisted.
   */
  public renderTemplateSample(
    dto: CreateTemplateDto,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<Buffer> {
    const design = this.sanitizeTemplateDto(dto);
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
    const base = this.certificatesRepository.createQueryBuilder('c');
    if (teacherId) {
      base
        .innerJoin('lesson_packages', 'pkg', 'pkg.id = c.package_id')
        .where('pkg.teacher_id = :teacherId', { teacherId });
    }

    const total = await base.getCount();

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const thisMonthQb = this.certificatesRepository
      .createQueryBuilder('c')
      .where('c.issued_at >= :monthStart', { monthStart });
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
        biBody('You can only use your own or platform templates', 'يمكنك استخدام قوالبك أو قوالب المنصة فقط'),
      );
    }
    return template;
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
