import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

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
import { Certificate } from './entities/certificate.entity';
import { CertificateStatus } from './entities/certificate-status.enum';
import { CertificateTemplate } from './entities/certificate-template.entity';

export const CERTIFICATE_ISSUED_EVENT = 'certificate.issued';

export interface CourseProgress {
  total: number;
  completed: number;
  percentage: number;
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
    options: { force?: boolean } = {},
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

    const template = await this.findDefaultTemplate();

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

  /* ===================== Reads ===================== */

  public async getMyCertificates(studentId: string): Promise<Certificate[]> {
    return this.certificatesRepository.find({
      where: { student_id: studentId },
      order: { issued_at: 'DESC' },
    });
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
    const template = certificate.template_id
      ? await this.templatesRepository.findOne({
          where: { id: certificate.template_id },
        })
      : await this.findDefaultTemplate();
    return this.pdfService.render(certificate, template, locale);
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

  /* ===================== Templates (admin) ===================== */

  public getTemplates(): Promise<CertificateTemplate[]> {
    return this.templatesRepository.find({ order: { created_at: 'DESC' } });
  }

  public async getTemplate(id: string): Promise<CertificateTemplate> {
    const template = await this.templatesRepository.findOne({ where: { id } });
    if (!template) {
      throw new NotFoundException(biBody('Template not found', 'القالب غير موجود'));
    }
    return template;
  }

  public async createTemplate(dto: CreateTemplateDto): Promise<CertificateTemplate> {
    const template = this.templatesRepository.create(dto);
    const saved = await this.templatesRepository.save(template);
    if (saved.is_default) {
      await this.unsetOtherDefaults(saved.id);
    }
    return saved;
  }

  public async updateTemplate(id: string, dto: UpdateTemplateDto): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id);
    Object.assign(template, dto);
    const saved = await this.templatesRepository.save(template);
    if (saved.is_default) {
      await this.unsetOtherDefaults(saved.id);
    }
    return saved;
  }

  public async deleteTemplate(id: string): Promise<void> {
    const template = await this.getTemplate(id);
    await this.templatesRepository.remove(template);
  }

  /* ===================== Helpers ===================== */

  private findDefaultTemplate(): Promise<CertificateTemplate | null> {
    return this.templatesRepository.findOne({ where: { is_default: true } });
  }

  private async unsetOtherDefaults(keepId: string): Promise<void> {
    await this.templatesRepository
      .createQueryBuilder()
      .update()
      .set({ is_default: false })
      .where('id != :keepId', { keepId })
      .andWhere('is_default = true')
      .execute();
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
