import { randomUUID } from 'node:crypto';

import { BadRequestException, type INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { CertificatesService } from '../../src/certificates/certificates.service';
import { Certificate } from '../../src/certificates/entities/certificate.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { ProgressService } from '../../src/lessons/progress.service';
import { AddCourseVersioning2076000000000 } from '../../src/migrations/2076000000000-AddCourseVersioning';
import { BackfillPackageCourseVersions2077000000000 } from '../../src/migrations/2077000000000-BackfillPackageCourseVersions';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { CourseVersion } from '../../src/packages/entities/course-version.entity';
import { CourseVersionItem } from '../../src/packages/entities/course-version-item.entity';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import { PackagesService } from '../../src/packages/packages.service';
import {
  CollectionParty,
  ItemType,
  LessonPurchase,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { PaymentFinalizationService } from '../../src/payments/services/payment-finalization.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * DEF-002 — Versioned Course + Snapshot lifecycle, against real PostgreSQL.
 * These prove the actual guarantees a hand-mocked EntityManager cannot: row
 * locking under real concurrency, DB-trigger immutability, and the legacy
 * data backfill against real rows.
 */
describe('course versioning lifecycle (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let packages: PackagesService;
  let finalization: PaymentFinalizationService;
  let certificates: CertificatesService;
  let progress: ProgressService;
  let userSuffix = 0;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    packages = app.get(PackagesService);
    finalization = app.get(PaymentFinalizationService);
    certificates = app.get(CertificatesService);
    progress = app.get(ProgressService);

    // `TYPEORM_SYNCHRONIZE` (this environment's e2e convention) creates every
    // table/column/FK from entity metadata, but the immutability triggers are
    // plain SQL a decorator can't express — apply that migration once. Its
    // legacy-package bootstrap step is a no-op against an empty database.
    // Production applies migrations inside a transaction (`migrationsTransactionMode:
    // 'each'` in data-source.ts) via TypeORM's own runner; calling `.up()`
    // directly here must wrap the same way — the migration's `CREATE TEMP
    // TABLE ... ON COMMIT DROP` step (used later, in the backfill migration
    // test) only survives across statements within one real transaction.
    await runMigrationUp(new AddCourseVersioning2076000000000());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    userSuffix = 0;
  });
  afterAll(async () => app.close());

  async function runMigrationUp(migration: {
    up: (runner: import('typeorm').QueryRunner) => Promise<void>;
  }) {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await migration.up(runner);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  /** Auto-issuance runs off an unawaited event emission — poll briefly. */
  async function waitForCertificate(studentId: string, packageId: string): Promise<Certificate> {
    const certificates_ = dataSource.getRepository(Certificate);
    for (let attempt = 0; attempt < 40; attempt++) {
      const found = await certificates_.findOne({
        where: { student_id: studentId, package_id: packageId },
      });
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `Certificate for student ${studentId} / package ${packageId} was not auto-issued in time`,
    );
  }

  async function makeUser(role: UserRole): Promise<User> {
    userSuffix += 1;
    const suffix = String(userSuffix).padStart(4, '0');
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({
        username: `cv-${role}-${suffix}`,
        name: `CV ${role} ${suffix}`,
        first_name: null,
        last_name: null,
        email: `cv-${role}-${suffix}@example.test`,
        phone: `01${suffix.padStart(9, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function makeSubject(): Promise<Subject> {
    const subjects = dataSource.getRepository(Subject);
    return subjects.save(
      subjects.create({
        name: 'Course versioning subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
  }

  async function makeLesson(
    teacherId: string,
    subjectId: string,
    title: string,
    overrides: Partial<Lesson> = {},
  ): Promise<Lesson> {
    const lessons = dataSource.getRepository(Lesson);
    return lessons.save(
      lessons.create({
        title,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 0,
        duration: 600,
        is_group: true,
        available_for_days: 365,
        students_count: 0,
        is_free_preview: false,
        ...overrides,
      }),
    );
  }

  /** Real checkout-finalization round trip for a PACKAGE order. */
  async function purchasePackage(
    studentId: string,
    teacherId: string,
    packageId: string,
    priceMajor: number,
    ref: string,
  ) {
    const finalAmountMinor = Math.round(priceMajor * 100);
    const commissionMinor = Math.round(finalAmountMinor * 0.3);
    const orders = dataSource.getRepository(Order);
    const payments = dataSource.getRepository(Payment);

    const order = await orders.save(
      orders.create({
        order_number: `E2E-CV-${ref}`,
        student_id: studentId,
        teacher_id: teacherId,
        item_type: ItemType.PACKAGE,
        item_id: packageId,
        quantity: 1,
        original_amount_minor: finalAmountMinor,
        discount_amount_minor: 0,
        final_amount_minor: finalAmountMinor,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: null,
        status: OrderStatus.AWAITING_PAYMENT,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        cart_checkout_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Course',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: commissionMinor,
        teacher_earning_minor: finalAmountMinor - commissionMinor,
        gateway_fee_bps: 0,
        gateway_fee_minor: 0,
        discount_snapshot: null,
        metadata: {},
        expires_at: new Date(Date.now() + 3_600_000),
        paid_at: null,
        cancelled_at: null,
      }),
    );

    const payment = await payments.save(
      payments.create({
        order_id: order.id,
        user_id: studentId,
        item_type: ItemType.PACKAGE,
        item_id: packageId,
        amount: priceMajor,
        discount_amount: 0,
        final_amount: priceMajor,
        amount_minor: finalAmountMinor,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: null,
        provider_reference: `e2e-cv-${ref}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        provider_order_reference: null,
        provider_transaction_id: null,
        idempotency_key: `e2e-cv-${ref}`,
        failure_reason: null,
        completed_at: null,
      }),
    );

    return finalization.finalizeSuccessfulPayment({
      orderId: order.id,
      paymentId: payment.id,
      sourceReference: `e2e-cv-${ref}`,
      verifiedAmountMinor: finalAmountMinor,
      verifiedCurrency: 'EGP',
    });
  }

  async function purchasedLessonIds(studentId: string, paymentId: string): Promise<string[]> {
    const rows = await dataSource.getRepository(LessonPurchase).find({
      where: { student_id: studentId, payment_id: paymentId },
    });
    return rows.map((r) => r.lesson_id).sort();
  }

  it('isolates purchased curriculum per version: additions do not retroactively grant, removals do not retroactively revoke, progress/certificates are judged per-purchaser', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student1 = await makeUser(UserRole.STUDENT);
    const student2 = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const lessonA = await makeLesson(teacher.id, subject.id, 'Lesson A');
    const lessonB = await makeLesson(teacher.id, subject.id, 'Lesson B');
    const lessonC = await makeLesson(teacher.id, subject.id, 'Lesson C');
    const lessonD = await makeLesson(teacher.id, subject.id, 'Lesson D');

    const course = await packages.create(teacher.id, {
      title: 'Versioned Course',
      subject_id: subject.id,
      price: 300,
      status: CourseStatus.PUBLISHED,
    } as never);

    await packages.addLessons(course.id, teacher.id, {
      lessons: [
        { lessonId: lessonA.id, orderIndex: 0 },
        { lessonId: lessonB.id, orderIndex: 1 },
        { lessonId: lessonC.id, orderIndex: 2 },
      ],
    } as never);

    // ── V1 purchase (A, B, C) — locks version 1. ────────────────────────────
    const purchase1 = await purchasePackage(student1.id, teacher.id, course.id, 300, 'p1');
    const pp1 = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student1.id, package_id: course.id } });
    expect(pp1.course_version_id).not.toBeNull();
    const version1 = await dataSource
      .getRepository(CourseVersion)
      .findOneOrFail({ where: { id: pp1.course_version_id! } });
    expect(version1.version_number).toBe(1);
    expect(version1.locked_at).not.toBeNull();
    expect(await purchasedLessonIds(student1.id, purchase1.payment.id)).toEqual(
      [lessonA.id, lessonB.id, lessonC.id].sort(),
    );

    // ── Teacher adds D after the sale: rolls over to version 2, live. ──────
    await packages.addLessons(course.id, teacher.id, {
      lessons: [{ lessonId: lessonD.id, orderIndex: 3 }],
    } as never);

    // V1 purchaser must still hold exactly A, B, C — never D.
    expect(await purchasedLessonIds(student1.id, purchase1.payment.id)).toEqual(
      [lessonA.id, lessonB.id, lessonC.id].sort(),
    );
    const stillV1 = await dataSource
      .getRepository(CourseVersion)
      .findOneOrFail({ where: { id: version1.id } });
    expect(stillV1.version_number).toBe(1); // untouched

    // ── New purchaser after D was added: gets A, B, C, D on version 2. ─────
    const purchase2 = await purchasePackage(student2.id, teacher.id, course.id, 300, 'p2');
    const pp2 = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student2.id, package_id: course.id } });
    expect(pp2.course_version_id).not.toBe(pp1.course_version_id);
    const version2 = await dataSource
      .getRepository(CourseVersion)
      .findOneOrFail({ where: { id: pp2.course_version_id! } });
    expect(version2.version_number).toBe(2);
    expect(await purchasedLessonIds(student2.id, purchase2.payment.id)).toEqual(
      [lessonA.id, lessonB.id, lessonC.id, lessonD.id].sort(),
    );

    // ── Teacher removes B from what's now version 2 (locked): rolls to v3. ─
    await packages.removeLessons(course.id, teacher.id, { lessonIds: [lessonB.id] } as never);

    // Student2 (v2 purchaser) keeps B — removal never retroactively revokes.
    expect(await purchasedLessonIds(student2.id, purchase2.payment.id)).toEqual(
      [lessonA.id, lessonB.id, lessonC.id, lessonD.id].sort(),
    );
    // Student1 (v1 purchaser) is completely unaffected either way.
    expect(await purchasedLessonIds(student1.id, purchase1.payment.id)).toEqual(
      [lessonA.id, lessonB.id, lessonC.id].sort(),
    );

    // A third purchaser now gets the latest (post-removal) version 3: A, C, D.
    const student3 = await makeUser(UserRole.STUDENT);
    const purchase3 = await purchasePackage(student3.id, teacher.id, course.id, 300, 'p3');
    const pp3 = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student3.id, package_id: course.id } });
    const version3 = await dataSource
      .getRepository(CourseVersion)
      .findOneOrFail({ where: { id: pp3.course_version_id! } });
    expect(version3.version_number).toBe(3);
    expect(await purchasedLessonIds(student3.id, purchase3.payment.id)).toEqual(
      [lessonA.id, lessonC.id, lessonD.id].sort(),
    );

    // ── Progress/certificates are judged per-purchaser's own version. ──────
    // Completing the last lesson crosses 100% and fires an unawaited
    // `lesson.completed` event (ProgressService) that auto-issues a
    // certificate in the background (CertificateIssuanceListener) — so once
    // a student's progress can reach 100% here, assert via `waitForCertificate`
    // rather than racing that listener with an explicit `issueForCourse` call.
    await progress.updateProgress(student1.id, lessonA.id, 600, 600);
    await progress.updateProgress(student1.id, lessonB.id, 600, 600);
    await progress.updateProgress(student1.id, lessonC.id, 600, 600);
    const progress1 = await certificates.getCourseProgress(student1.id, course.id);
    expect(progress1).toEqual({ total: 3, completed: 3, percentage: 100 });
    const certificate1 = await waitForCertificate(student1.id, course.id);
    expect(certificate1.completion_percentage).toBe(100);

    // Student2 has completed A, B, C but not their 4th lesson (D) — 75%, not
    // eligible, even though student1's course "looks complete" at 3 lessons.
    // (Below 100%, auto-issuance never fires, so calling issueForCourse
    // directly here is race-free.)
    await progress.updateProgress(student2.id, lessonA.id, 600, 600);
    await progress.updateProgress(student2.id, lessonB.id, 600, 600);
    await progress.updateProgress(student2.id, lessonC.id, 600, 600);
    const progress2 = await certificates.getCourseProgress(student2.id, course.id);
    expect(progress2).toEqual({ total: 4, completed: 3, percentage: 75 });
    await expect(certificates.issueForCourse(student2.id, course.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    await progress.updateProgress(student2.id, lessonD.id, 600, 600);
    const progress2Complete = await certificates.getCourseProgress(student2.id, course.id);
    expect(progress2Complete).toEqual({ total: 4, completed: 4, percentage: 100 });
    const certificate2 = await waitForCertificate(student2.id, course.id);
    expect(certificate2.completion_percentage).toBe(100);
  });

  it('preserves existing lesson-expiry behavior through the version snapshot', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const shortLived = await makeLesson(teacher.id, subject.id, 'Expires tomorrow', {
      available_for_days: 1,
    });
    const longLived = await makeLesson(teacher.id, subject.id, 'Expires next year', {
      available_for_days: 365,
    });

    const course = await packages.create(teacher.id, {
      title: 'Expiry course',
      subject_id: subject.id,
      price: 100,
      status: CourseStatus.PUBLISHED,
    } as never);
    await packages.addLessons(course.id, teacher.id, {
      lessons: [
        { lessonId: shortLived.id, orderIndex: 0 },
        { lessonId: longLived.id, orderIndex: 1 },
      ],
    } as never);

    await purchasePackage(student.id, teacher.id, course.id, 100, 'expiry');

    const purchases = await dataSource
      .getRepository(LessonPurchase)
      .find({ where: { student_id: student.id } });
    const short = purchases.find((p) => p.lesson_id === shortLived.id)!;
    const long = purchases.find((p) => p.lesson_id === longLived.id)!;
    expect(long.access_expires_at.getTime() - short.access_expires_at.getTime()).toBe(
      364 * 24 * 60 * 60_000,
    );
    expect(short.access_expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(short.access_expires_at.getTime()).toBeLessThan(Date.now() + 2 * 24 * 60 * 60_000);
  });

  it('serializes a concurrent purchase against a concurrent curriculum edit without ever granting a mixed/partial snapshot', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const lessonA = await makeLesson(teacher.id, subject.id, 'Race A');
    const lessonB = await makeLesson(teacher.id, subject.id, 'Race B');
    const lessonC = await makeLesson(teacher.id, subject.id, 'Race C');

    const course = await packages.create(teacher.id, {
      title: 'Race course',
      subject_id: subject.id,
      price: 150,
      status: CourseStatus.PUBLISHED,
    } as never);
    await packages.addLessons(course.id, teacher.id, {
      lessons: [
        { lessonId: lessonA.id, orderIndex: 0 },
        { lessonId: lessonB.id, orderIndex: 1 },
      ],
    } as never);

    const [purchaseResult] = await Promise.all([
      purchasePackage(student.id, teacher.id, course.id, 150, 'race'),
      packages.addLessons(course.id, teacher.id, {
        lessons: [{ lessonId: lessonC.id, orderIndex: 2 }],
      } as never),
    ]);

    const pp = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student.id, package_id: course.id } });
    const grantedVersionId = pp.course_version_id!;
    const versionItems = await dataSource
      .getRepository(CourseVersionItem)
      .find({ where: { version_id: grantedVersionId } });
    const grantedLessonIds = await purchasedLessonIds(student.id, purchaseResult.payment.id);

    // Whichever way the race resolved (purchase locked {A,B} before the edit,
    // or the edit landed on the still-unlocked draft before the purchase
    // locked it), the granted LessonPurchase set must exactly match the
    // version's own frozen snapshot — self-consistent, never a torn mix.
    expect([2, 3]).toContain(versionItems.length);
    expect(grantedLessonIds).toEqual(versionItems.map((i) => i.lesson_id).sort());
    expect(grantedLessonIds).toContain(lessonA.id);
    expect(grantedLessonIds).toContain(lessonB.id);
  });

  it('does not create a duplicate snapshot or purchase when finalization is retried concurrently', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const lessonA = await makeLesson(teacher.id, subject.id, 'Retry A');
    const lessonB = await makeLesson(teacher.id, subject.id, 'Retry B');

    const course = await packages.create(teacher.id, {
      title: 'Retry course',
      subject_id: subject.id,
      price: 120,
      status: CourseStatus.PUBLISHED,
    } as never);
    await packages.addLessons(course.id, teacher.id, {
      lessons: [
        { lessonId: lessonA.id, orderIndex: 0 },
        { lessonId: lessonB.id, orderIndex: 1 },
      ],
    } as never);

    const finalAmountMinor = 12_000;
    const orders = dataSource.getRepository(Order);
    const payments = dataSource.getRepository(Payment);
    const order = await orders.save(
      orders.create({
        order_number: 'E2E-CV-retry',
        student_id: student.id,
        teacher_id: teacher.id,
        item_type: ItemType.PACKAGE,
        item_id: course.id,
        quantity: 1,
        original_amount_minor: finalAmountMinor,
        discount_amount_minor: 0,
        final_amount_minor: finalAmountMinor,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: null,
        status: OrderStatus.AWAITING_PAYMENT,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        cart_checkout_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Course',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 3_600,
        teacher_earning_minor: 8_400,
        gateway_fee_bps: 0,
        gateway_fee_minor: 0,
        discount_snapshot: null,
        metadata: {},
        expires_at: new Date(Date.now() + 3_600_000),
        paid_at: null,
        cancelled_at: null,
      }),
    );
    const payment = await payments.save(
      payments.create({
        order_id: order.id,
        user_id: student.id,
        item_type: ItemType.PACKAGE,
        item_id: course.id,
        amount: 120,
        discount_amount: 0,
        final_amount: 120,
        amount_minor: finalAmountMinor,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: null,
        provider_reference: 'e2e-cv-retry',
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        provider_order_reference: null,
        provider_transaction_id: null,
        idempotency_key: 'e2e-cv-retry',
        failure_reason: null,
        completed_at: null,
      }),
    );

    const input = {
      orderId: order.id,
      paymentId: payment.id,
      sourceReference: 'e2e-cv-retry',
      verifiedAmountMinor: finalAmountMinor,
      verifiedCurrency: 'EGP',
    };
    const [first, second] = await Promise.all([
      finalization.finalizeSuccessfulPayment(input),
      finalization.finalizeSuccessfulPayment(input),
    ]);
    expect([first.alreadyFinalized, second.alreadyFinalized].sort()).toEqual([false, true]);

    expect(
      await dataSource
        .getRepository(PackagePurchase)
        .count({ where: { student_id: student.id, package_id: course.id } }),
    ).toBe(1);
    const pp = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student.id, package_id: course.id } });
    expect(
      await dataSource
        .getRepository(CourseVersionItem)
        .count({ where: { version_id: pp.course_version_id! } }),
    ).toBe(2);
    expect(await purchasedLessonIds(student.id, payment.id)).toEqual(
      [lessonA.id, lessonB.id].sort(),
    );
  });

  it('enforces version-item and lock immutability at the database level', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const lessonA = await makeLesson(teacher.id, subject.id, 'Immutable A');

    const course = await packages.create(teacher.id, {
      title: 'Immutability course',
      subject_id: subject.id,
      price: 80,
      status: CourseStatus.PUBLISHED,
    } as never);
    await packages.addLessons(course.id, teacher.id, {
      lessons: [{ lessonId: lessonA.id, orderIndex: 0 }],
    } as never);
    await purchasePackage(student.id, teacher.id, course.id, 80, 'immutable');

    const pp = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student.id, package_id: course.id } });
    const lockedVersionId = pp.course_version_id!;
    const item = await dataSource
      .getRepository(CourseVersionItem)
      .findOneOrFail({ where: { version_id: lockedVersionId } });

    await expect(
      dataSource.query('UPDATE course_version_items SET order_index = 99 WHERE id = $1', [item.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      dataSource.query('DELETE FROM course_version_items WHERE id = $1', [item.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      dataSource.query('UPDATE course_versions SET locked_at = NULL WHERE id = $1', [
        lockedVersionId,
      ]),
    ).rejects.toThrow(/cannot change/i);
  });

  it('reconstructs historical versions for legacy purchases from LessonPurchase evidence, not blindly from current curriculum', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student1 = await makeUser(UserRole.STUDENT);
    const student2 = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const lessonA = await makeLesson(teacher.id, subject.id, 'Legacy A');
    const lessonB = await makeLesson(teacher.id, subject.id, 'Legacy B');
    const lessonC = await makeLesson(teacher.id, subject.id, 'Legacy C');
    const lessonD = await makeLesson(teacher.id, subject.id, 'Legacy D');

    // Simulate a pre-DEF-002 course: created via raw repositories, bypassing
    // `PackagesService.create` entirely, so it has NO CourseVersion at all —
    // exactly the shape every course in production has before this migration.
    const packagesRepo = dataSource.getRepository(LessonPackage);
    const legacyCourse = await packagesRepo.save(
      packagesRepo.create({
        title: 'Legacy course',
        title_ar: 'Legacy course',
        description: null,
        description_ar: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        price: 100,
        original_price: null,
        is_active: true,
        thumbnail: null,
        status: CourseStatus.PUBLISHED,
        current_version_id: null,
      }),
    );
    // Today's live curriculum has already drifted to A, B, C, D by the time
    // the migration runs.
    const items = dataSource.getRepository(LessonPackageItem);
    await items.save([
      items.create({ package_id: legacyCourse.id, lesson_id: lessonA.id, order_index: 0 }),
      items.create({ package_id: legacyCourse.id, lesson_id: lessonB.id, order_index: 1 }),
      items.create({ package_id: legacyCourse.id, lesson_id: lessonC.id, order_index: 2 }),
      items.create({ package_id: legacyCourse.id, lesson_id: lessonD.id, order_index: 3 }),
    ]);

    const payments = dataSource.getRepository(Payment);
    const makeLegacyPayment = async (ref: string) =>
      payments.save(
        payments.create({
          order_id: null,
          user_id: teacher.id,
          item_type: ItemType.PACKAGE,
          item_id: legacyCourse.id,
          amount: 100,
          discount_amount: 0,
          final_amount: 100,
          amount_minor: 10_000,
          currency: 'EGP',
          channel: PaymentChannel.MANUAL,
          provider: null,
          provider_reference: ref,
          status: PaymentStatus.COMPLETED,
          payment_method: PaymentMethod.MANUAL,
          provider_order_reference: null,
          provider_transaction_id: null,
          idempotency_key: ref,
          failure_reason: null,
          completed_at: new Date(),
        }),
      );
    const payment1 = await makeLegacyPayment('legacy-p1');
    const payment2 = await makeLegacyPayment('legacy-p2');

    const purchasedAt1 = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const purchasedAt2 = new Date(Date.now() - 5 * 24 * 60 * 60_000);
    const packagePurchases = dataSource.getRepository(PackagePurchase);
    await packagePurchases.save(
      packagePurchases.create({
        student_id: student1.id,
        package_id: legacyCourse.id,
        course_version_id: null,
        payment_id: payment1.id,
        price_paid: 100,
        purchased_at: purchasedAt1,
        revoked_at: null,
        revocation_reason: null,
      }),
    );
    await packagePurchases.save(
      packagePurchases.create({
        student_id: student2.id,
        package_id: legacyCourse.id,
        course_version_id: null,
        payment_id: payment2.id,
        price_paid: 100,
        purchased_at: purchasedAt2,
        revoked_at: null,
        revocation_reason: null,
      }),
    );

    // Student1 originally received only A, B; student2 received A, B, C —
    // the durable evidence of what curriculum each purchase actually bought.
    const lessonPurchases = dataSource.getRepository(LessonPurchase);
    const grant = (studentId: string, paymentId: string, lessonId: string, at: Date) =>
      lessonPurchases.create({
        student_id: studentId,
        lesson_id: lessonId,
        payment_id: paymentId,
        price_paid: 0,
        access_granted_at: at,
        access_expires_at: new Date(at.getTime() + 365 * 24 * 60 * 60_000),
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      });
    await lessonPurchases.save([
      grant(student1.id, payment1.id, lessonA.id, purchasedAt1),
      grant(student1.id, payment1.id, lessonB.id, purchasedAt1),
      grant(student2.id, payment2.id, lessonA.id, purchasedAt2),
      grant(student2.id, payment2.id, lessonB.id, purchasedAt2),
      grant(student2.id, payment2.id, lessonC.id, purchasedAt2),
    ]);

    // Re-running the schema migration bootstraps version 1 for this specific
    // legacy course (idempotent — a no-op for every other course in the
    // suite, which already has its own version from `create()`).
    await runMigrationUp(new AddCourseVersioning2076000000000());
    await runMigrationUp(new BackfillPackageCourseVersions2077000000000());

    const versions = await dataSource
      .getRepository(CourseVersion)
      .find({ where: { package_id: legacyCourse.id }, order: { version_number: 'ASC' } });
    // v1 (reused bootstrap, locked to student1's fingerprint), v2 (student2's
    // fingerprint), v3 (fresh unlocked "current", mirroring today's live A-D).
    expect(versions).toHaveLength(3);
    const [v1, v2, v3] = versions;
    expect(v1!.locked_at).not.toBeNull();
    expect(v2!.locked_at).not.toBeNull();
    expect(v3!.locked_at).toBeNull();

    const itemsOf = async (versionId: string) =>
      (await dataSource.getRepository(CourseVersionItem).find({ where: { version_id: versionId } }))
        .map((i) => i.lesson_id)
        .sort();
    expect(await itemsOf(v1!.id)).toEqual([lessonA.id, lessonB.id].sort());
    expect(await itemsOf(v2!.id)).toEqual([lessonA.id, lessonB.id, lessonC.id].sort());

    const pp1 = await packagePurchases.findOneOrFail({ where: { student_id: student1.id } });
    const pp2 = await packagePurchases.findOneOrFail({ where: { student_id: student2.id } });
    expect(pp1.course_version_id).toBe(v1!.id);
    expect(pp2.course_version_id).toBe(v2!.id);

    const refreshedCourse = await packagesRepo.findOneOrFail({ where: { id: legacyCourse.id } });
    expect(refreshedCourse.current_version_id).toBe(v3!.id);
  });

  it('T057: getMyCourseProgressBatch equals per-package getMyCourseProgress on every eligibility edge, in <= 5 statements', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const l1 = await makeLesson(teacher.id, subject.id, 'L1');
    const l2 = await makeLesson(teacher.id, subject.id, 'L2');
    const l3 = await makeLesson(teacher.id, subject.id, 'L3');
    const l4 = await makeLesson(teacher.id, subject.id, 'L4');

    const course = async (title: string, lessons: Lesson[]): Promise<LessonPackage> => {
      const created = await packages.create(teacher.id, {
        title,
        subject_id: subject.id,
        price: 100,
        status: CourseStatus.PUBLISHED,
      } as never);
      await packages.addLessons(created.id, teacher.id, {
        lessons: lessons.map((lesson, orderIndex) => ({ lessonId: lesson.id, orderIndex })),
      } as never);
      return created as LessonPackage;
    };
    /** A valid purchase that never went through finalization (no locked version). */
    const looseUnversionedPurchase = async (pkg: LessonPackage): Promise<void> => {
      const payments = dataSource.getRepository(Payment);
      const payment = await payments.save(
        payments.create({
          order_id: null,
          user_id: student.id,
          item_type: ItemType.PACKAGE,
          item_id: pkg.id,
          amount: 100,
          discount_amount: 0,
          final_amount: 100,
          amount_minor: 10_000,
          currency: 'EGP',
          channel: PaymentChannel.MANUAL,
          provider: null,
          provider_reference: `loose-${pkg.id}`,
          status: PaymentStatus.COMPLETED,
          payment_method: PaymentMethod.MANUAL,
          idempotency_key: `loose-${pkg.id}`,
        }),
      );
      await dataSource.getRepository(PackagePurchase).save(
        dataSource.getRepository(PackagePurchase).create({
          student_id: student.id,
          package_id: pkg.id,
          course_version_id: null,
          payment_id: payment.id,
          price_paid: 100,
          purchased_at: new Date(),
          revoked_at: null,
          revocation_reason: null,
        }),
      );
    };

    // locked version, partially completed
    const locked = await course('locked', [l1, l2, l3, l4]);
    await purchasePackage(student.id, teacher.id, locked.id, 100, 'b-locked');
    await progress.updateProgress(student.id, l1.id, 600, 600);
    await progress.updateProgress(student.id, l2.id, 600, 600);
    // purchase whose version was nulled: falls through to the package's current version
    const nulled = await course('nulled', [l1, l2]);
    await purchasePackage(student.id, teacher.id, nulled.id, 100, 'b-nulled');
    await dataSource.query(
      'UPDATE package_purchases SET course_version_id = NULL WHERE package_id = $1',
      [nulled.id],
    );
    // unlocked draft: judged by lesson_package_items
    const draft = await course('draft', [l1, l3]);
    await looseUnversionedPurchase(draft);
    // soft-deleted package with a null-version purchase
    const gone = await course('gone', [l1, l2, l3]);
    await looseUnversionedPurchase(gone);
    await dataSource.getRepository(LessonPackage).softDelete({ id: gone.id });
    // revoked purchase
    const revoked = await course('revoked', [l1, l2]);
    await purchasePackage(student.id, teacher.id, revoked.id, 100, 'b-revoked');
    await dataSource.query(
      'UPDATE package_purchases SET revoked_at = now() WHERE package_id = $1',
      [revoked.id],
    );
    // never purchased
    const unowned = await course('unowned', [l1, l2]);
    // the same lesson listed twice in a locked version (no unique constraint): completed once must count once
    const dup = await course('dup', [l1, l2]);
    await purchasePackage(student.id, teacher.id, dup.id, 100, 'b-dup');
    const dupVersion = (
      await dataSource
        .getRepository(PackagePurchase)
        .findOneOrFail({ where: { package_id: dup.id } })
    ).course_version_id as string;
    await dataSource.query('ALTER TABLE course_version_items DISABLE TRIGGER USER');
    try {
      await dataSource.query(
        'INSERT INTO course_version_items (version_id, lesson_id, order_index) SELECT version_id, lesson_id, order_index + 10 FROM course_version_items WHERE version_id = $1 AND lesson_id = $2',
        [dupVersion, l1.id],
      );
    } finally {
      await dataSource.query('ALTER TABLE course_version_items ENABLE TRIGGER USER');
    }

    const requested = [
      locked.id,
      nulled.id,
      draft.id,
      gone.id,
      revoked.id,
      unowned.id,
      dup.id,
      randomUUID(),
      locked.id,
    ];
    const distinct = [...new Set(requested)];

    const counter = new StatementCounter(dataSource);
    counter.start();
    const batch = await certificates.getMyCourseProgressBatch(student.id, requested);
    const statements = counter.stop().length;

    expect(Object.keys(batch).sort()).toEqual([...distinct].sort());
    for (const id of distinct) {
      expect(batch[id]).toEqual(await certificates.getMyCourseProgress(student.id, id));
    }
    // Fixture sanity: the edges produced distinct, non-trivial answers.
    expect(batch[locked.id]).toEqual({ total: 4, completed: 2, percentage: 50 });
    expect(batch[dup.id]?.total).toBe(3); // duplicate row counts in the total, exactly as today
    expect(batch[dup.id]?.completed).toBe(2); // L1 (listed twice) + L2, each completed once: 2 distinct, a COUNT(*) bug would give 3
    expect(batch[revoked.id]).toEqual({ total: 0, completed: 0, percentage: 0 });
    expect(batch[unowned.id]).toEqual({ total: 0, completed: 0, percentage: 0 });
    expect(batch[draft.id]?.total).toBe(2);
    expect(statements).toBeLessThanOrEqual(5);
  });
});
