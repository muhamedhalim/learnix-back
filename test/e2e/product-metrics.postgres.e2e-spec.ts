import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { AttemptState } from '../../src/exams/entities/attempt-state.enum';
import { DEFAULT_EXAM_CONFIG } from '../../src/exams/entities/exam-config.interface';
import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamAttempt } from '../../src/exams/entities/exam-attempt.entity';
import { ExamStatus } from '../../src/exams/entities/exam-status.enum';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonProgress } from '../../src/lessons/entities/lesson-progress.entity';
import { LessonStatus } from '../../src/lessons/entities/lesson-status.enum';
import { LessonsService } from '../../src/lessons/lessons.service';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
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
import { RefundsService } from '../../src/payments/services/refunds.service';
import { LessonReview } from '../../src/reviews/entities/lesson-review.entity';
import { ReviewStatus } from '../../src/reviews/entities/review-status.enum';
import { TeacherReview } from '../../src/reviews/entities/teacher-review.entity';
import { StudentProfile } from '../../src/students/entities/student-profile.entity';
import { StudentsService } from '../../src/students/students.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { SubjectsService } from '../../src/subjects/subjects.service';
import { TeacherProfile } from '../../src/teachers/entities/teacher-profile.entity';
import { TeachersService } from '../../src/teachers/teachers.service';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase } from './fixtures';

/**
 * DEF-007 — every published Stats/Counts metric, against real PostgreSQL.
 *
 * These assert *business outcomes*, not HTTP 200s: that a discounted sale
 * contributes what was paid rather than the list price, that a refund actually
 * moves the money back out, that an abandoned checkout contributes nothing, and
 * that "no data" reads as `null` rather than a zero that looks like a measured
 * result. Real Postgres is required because every one of these is a SQL
 * aggregate over the real finance tables — a mocked repository would only prove
 * the mock agrees with itself.
 */
describe('product & learning metrics (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let lessons: LessonsService;
  let packages: PackagesService;
  let students: StudentsService;
  let subjects: SubjectsService;
  let teachers: TeachersService;
  let finalization: PaymentFinalizationService;
  let refunds: RefundsService;
  let suffix = 0;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    lessons = app.get(LessonsService);
    packages = app.get(PackagesService);
    students = app.get(StudentsService);
    subjects = app.get(SubjectsService);
    teachers = app.get(TeachersService);
    finalization = app.get(PaymentFinalizationService);
    refunds = app.get(RefundsService);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    suffix = 0;
  });

  afterAll(async () => app.close());

  /* ───────────────────────────────── fixtures ───────────────────────────── */

  async function makeUser(role: UserRole, status = UserStatus.APPROVED): Promise<User> {
    suffix += 1;
    const tag = String(suffix).padStart(4, '0');
    const repo = dataSource.getRepository(User);
    return repo.save(
      repo.create({
        username: `pm-${role}-${tag}`,
        name: `PM ${role} ${tag}`,
        first_name: null,
        last_name: null,
        email: `pm-${role}-${tag}@example.test`,
        phone: `01${tag.padStart(9, '0')}`,
        role,
        status,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function makeStudent(): Promise<{ user: User; profile: StudentProfile }> {
    const user = await makeUser(UserRole.STUDENT);
    const repo = dataSource.getRepository(StudentProfile);
    const profile = await repo.save(repo.create({ user_id: user.id }));
    return { user, profile };
  }

  async function makeTeacherProfile(user: User, subjectIds: string[] = []): Promise<TeacherProfile> {
    const repo = dataSource.getRepository(TeacherProfile);
    const profile = await repo.save(
      repo.create({
        user_id: user.id,
        qualifications: 'MSc',
        years_of_experience: 5,
        bio: null,
        bio_ar: null,
        professional_title: null,
        professional_title_ar: null,
        specializations: [],
        languages: [],
        skills: [],
        education: [],
        certificates: [],
      }),
    );
    for (const subjectId of subjectIds) {
      await dataSource.query(
        'INSERT INTO teacher_subjects (teacher_profile_id, subject_id) VALUES ($1, $2)',
        [profile.id, subjectId],
      );
    }
    return profile;
  }

  async function makeSubject(name: string): Promise<Subject> {
    const repo = dataSource.getRepository(Subject);
    return repo.save(
      repo.create({
        name,
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
    priceMajor = 1000,
    status = LessonStatus.PUBLISHED,
  ): Promise<Lesson> {
    const repo = dataSource.getRepository(Lesson);
    return repo.save(
      repo.create({
        title,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: priceMajor,
        duration: 600,
        is_group: true,
        available_for_days: 365,
        students_count: 0,
        is_free_preview: false,
        status,
      }),
    );
  }

  /**
   * Builds a course through `PackagesService` so the DEF-002 version machinery
   * runs for real: creation opens draft version 1 and `addLessons` rolls a new
   * version once the current one is locked by a purchase. Inserting rows
   * directly would leave `current_version_id` null and finalisation would
   * reject the sale with "Course has no purchasable version".
   */
  async function makePackage(
    teacherId: string,
    subjectId: string,
    lessonIds: string[],
    priceMajor = 1500,
  ): Promise<LessonPackage> {
    const created = await packages.create(teacherId, {
      title: `Course ${String(++suffix)}`,
      description: 'E2E course',
      subject_id: subjectId,
      price: priceMajor,
    });
    if (lessonIds.length > 0) {
      await packages.addLessons(created.id, teacherId, {
        lessons: lessonIds.map((lessonId, index) => ({ lessonId, orderIndex: index })),
      });
    }
    // `create` leaves a course in DRAFT; the metrics under test are independent
    // of publishing state, but purchases and previews expect a live course.
    await dataSource
      .getRepository(LessonPackage)
      .update({ id: created.id }, { status: CourseStatus.PUBLISHED, is_active: true });
    return dataSource.getRepository(LessonPackage).findOneByOrFail({ id: created.id });
  }

  /**
   * A real checkout → finalisation round trip, so orders, payments, purchases,
   * entitlements and ledger entries are all written by production code.
   *
   * `listMajor` is the catalogue price and `discountMajor` what came off it, so
   * a test can state "1000 list, 200 off" and the metrics have to report 800.
   */
  async function purchase(options: {
    studentId: string;
    teacherId: string;
    itemType: ItemType;
    itemId: string;
    listMajor: number;
    discountMajor?: number;
    commissionBps?: number;
  }): Promise<{ order: Order; payment: Payment }> {
    const tag = String(++suffix).padStart(4, '0');
    const listMinor = Math.round(options.listMajor * 100);
    const discountMinor = Math.round((options.discountMajor ?? 0) * 100);
    const finalMinor = listMinor - discountMinor;
    const commissionBps = options.commissionBps ?? 3000;
    const commissionMinor = Math.floor((finalMinor * commissionBps) / 10_000);

    const orders = dataSource.getRepository(Order);
    const payments = dataSource.getRepository(Payment);

    const order = await orders.save(
      orders.create({
        order_number: `E2E-PM-${tag}`,
        student_id: options.studentId,
        teacher_id: options.teacherId,
        item_type: options.itemType,
        item_id: options.itemId,
        quantity: 1,
        original_amount_minor: listMinor,
        discount_amount_minor: discountMinor,
        final_amount_minor: finalMinor,
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
        product_title_snapshot: 'Product',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: commissionBps,
        platform_commission_minor: commissionMinor,
        teacher_earning_minor: finalMinor - commissionMinor,
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
        user_id: options.studentId,
        item_type: options.itemType,
        item_id: options.itemId,
        amount: options.listMajor,
        discount_amount: options.discountMajor ?? 0,
        final_amount: finalMinor / 100,
        amount_minor: finalMinor,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: null,
        provider_reference: `e2e-pm-${tag}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        paymob_order_id: null,
        paymob_transaction_id: null,
        idempotency_key: `e2e-pm-${tag}`,
        failure_reason: null,
        completed_at: null,
      }),
    );

    await finalization.finalizeSuccessfulPayment({
      orderId: order.id,
      paymentId: payment.id,
      sourceReference: `e2e-pm-${tag}`,
      verifiedAmountMinor: finalMinor,
      verifiedCurrency: 'EGP',
    });

    return {
      order: (await orders.findOneByOrFail({ id: order.id })) as Order,
      payment: (await payments.findOneByOrFail({ id: payment.id })) as Payment,
    };
  }

  /** An order that never settles — the population every metric must exclude. */
  async function unpaidOrder(options: {
    studentId: string;
    teacherId: string;
    itemType: ItemType;
    itemId: string;
    listMajor: number;
    status: OrderStatus;
  }): Promise<Order> {
    const tag = String(++suffix).padStart(4, '0');
    const minor = Math.round(options.listMajor * 100);
    const orders = dataSource.getRepository(Order);
    return orders.save(
      orders.create({
        order_number: `E2E-PM-UNPAID-${tag}`,
        student_id: options.studentId,
        teacher_id: options.teacherId,
        item_type: options.itemType,
        item_id: options.itemId,
        quantity: 1,
        original_amount_minor: minor,
        discount_amount_minor: 0,
        final_amount_minor: minor,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: null,
        status: options.status,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        cart_checkout_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Product',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: Math.floor(minor * 0.3),
        teacher_earning_minor: minor - Math.floor(minor * 0.3),
        gateway_fee_bps: 0,
        gateway_fee_minor: 0,
        discount_snapshot: null,
        metadata: {},
        expires_at: new Date(Date.now() + 3_600_000),
        paid_at: null,
        cancelled_at: options.status === OrderStatus.CANCELLED ? new Date() : null,
      }),
    );
  }

  /**
   * Finalisation emits notification and domain-event writes without awaiting
   * them. A refund immediately afterwards takes pessimistic row locks and a
   * teacher advisory lock on the same rows, and the two collide — observed as
   * intermittent deadlocks and as a refund row that a following transaction
   * could not see. Letting the loop drain first keeps these assertions about
   * metric correctness rather than about lock scheduling.
   */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  /** Request + complete a refund through the real service (provider-verified). */
  async function refund(orderId: string, amountMinor: number, adminId: string): Promise<void> {
    await settle();
    const requested = await refunds.request(
      { order_id: orderId, amount_minor: amountMinor, reason_code: 'e2e_test' },
      adminId,
    );
    await refunds.complete(
      requested.id,
      { external_method: 'gateway', external_reference: `e2e-refund-${requested.id}` },
      adminId,
      true,
    );
    await settle();
  }

  async function review(
    lessonId: string,
    studentId: string,
    rating: number,
    status = ReviewStatus.APPROVED,
  ): Promise<void> {
    const repo = dataSource.getRepository(LessonReview);
    await repo.save(
      repo.create({ lesson_id: lessonId, student_id: studentId, rating, comment: null, status }),
    );
  }

  /* ─────────────────────────────── lesson stats ─────────────────────────── */

  describe('lesson stats', () => {
    it('reports what students actually paid: discounts reduce it, refunds remove it, unsettled orders never enter it', async () => {
      const admin = await makeUser(UserRole.ADMIN);
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Lesson finance');
      const lesson = await makeLesson(teacher.id, subject.id, 'Algebra', 1000);

      const full = await makeStudent();
      const discounted = await makeStudent();
      const fullyRefunded = await makeStudent();
      const partiallyRefunded = await makeStudent();
      const abandoned = await makeStudent();
      const cancelled = await makeStudent();

      const base = {
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 1000,
      };
      await purchase({ ...base, studentId: full.user.id });
      await purchase({ ...base, studentId: discounted.user.id, discountMajor: 200 });
      const refunded = await purchase({ ...base, studentId: fullyRefunded.user.id });
      const partial = await purchase({ ...base, studentId: partiallyRefunded.user.id });

      // Never paid, and never cancelled-after-payment: pure noise that the old
      // `price × students_count` estimate had no way to exclude.
      await unpaidOrder({
        ...base,
        studentId: abandoned.user.id,
        status: OrderStatus.AWAITING_PAYMENT,
      });
      await unpaidOrder({
        ...base,
        studentId: cancelled.user.id,
        status: OrderStatus.CANCELLED,
      });

      await refund(refunded.order.id, 100_000, admin.id);
      await refund(partial.order.id, 30_000, admin.id);

      const stats = await lessons.getLessonStats(lesson.id);

      // Four settled orders; the abandoned and cancelled ones contribute nothing.
      expect(stats.purchaseCount).toBe(4);
      expect(stats.uniqueStudentCount).toBe(4);

      // 1000 + 800 (discounted) + 1000 + 1000
      expect(stats.grossRevenue).toBe(3800);
      expect(stats.discountAmount).toBe(200);
      // A full 1000 plus a partial 300.
      expect(stats.refundedAmount).toBe(1300);
      expect(stats.totalRevenue).toBe(2500);

      // Commission is 30% of each settled sale, less the same proportional
      // reversal the ledger posts: 300 + 240 + 300 + 300 = 1140 charged,
      // 300 (full) + 90 (30% of the 300 partial) = 390 reversed.
      expect(stats.platformCommission).toBe(750);
      expect(stats.teacherEarnings).toBe(1750);
      expect(stats.platformCommission + stats.teacherEarnings).toBe(stats.totalRevenue);

      expect(stats.currency).toBe('EGP');
      expect(stats.mixedCurrency).toBe(false);
    });

    it('never reports the list price as revenue when a discount was applied', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Discount only');
      const lesson = await makeLesson(teacher.id, subject.id, 'Discounted', 1000);
      const student = await makeStudent();

      await purchase({
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 1000,
        discountMajor: 200,
      });

      const stats = await lessons.getLessonStats(lesson.id);

      expect(stats.totalRevenue).toBe(800);
      // The pre-DEF-007 estimate was `lesson.price × count` = 1000.
      expect(stats.totalRevenue).not.toBe(lesson.price * stats.purchaseCount);
    });

    it('counts a repeat buyer once in unique students but once per order in purchases', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Repeat buyer');
      const lesson = await makeLesson(teacher.id, subject.id, 'Renewable', 500);
      const student = await makeStudent();

      const base = {
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 500,
      };
      await purchase(base);
      await purchase(base);

      const stats = await lessons.getLessonStats(lesson.id);

      expect(stats.purchaseCount).toBe(2);
      expect(stats.uniqueStudentCount).toBe(1);
      expect(stats.studentsWithAccessCount).toBe(1);
      expect(stats.grossRevenue).toBe(1000);
    });

    it('counts students who got the lesson inside a course, and drops access revoked by a full refund', async () => {
      const admin = await makeUser(UserRole.ADMIN);
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Bundled access');
      const lesson = await makeLesson(teacher.id, subject.id, 'Shared lesson', 400);
      const pkg = await makePackage(teacher.id, subject.id, [lesson.id], 1500);

      const direct = await makeStudent();
      const viaCourse = await makeStudent();
      const refundedDirect = await makeStudent();

      await purchase({
        studentId: direct.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 400,
      });
      await purchase({
        studentId: viaCourse.user.id,
        teacherId: teacher.id,
        itemType: ItemType.PACKAGE,
        itemId: pkg.id,
        listMajor: 1500,
      });
      const toRefund = await purchase({
        studentId: refundedDirect.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 400,
      });
      await refund(toRefund.order.id, 40_000, admin.id);

      const stats = await lessons.getLessonStats(lesson.id);

      // Access: the direct buyer and the course buyer. The fully-refunded
      // buyer's lesson_purchases row was revoked, so they are gone.
      expect(stats.studentsWithAccessCount).toBe(2);
      // Direct sales only — the course sale's money belongs to the course.
      expect(stats.purchaseCount).toBe(2);
      expect(stats.grossRevenue).toBe(800);
      expect(stats.totalRevenue).toBe(400);
    });

    it('reports an unrated lesson as null and averages only approved reviews', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Ratings');
      const lesson = await makeLesson(teacher.id, subject.id, 'Rated', 100);

      const unrated = await lessons.getLessonStats(lesson.id);
      // Not 0 — a lesson nobody has reviewed has no rating, not one star.
      expect(unrated.averageRating).toBeNull();
      expect(unrated.reviewCount).toBe(0);

      const a = await makeStudent();
      const b = await makeStudent();
      const moderated = await makeStudent();
      await review(lesson.id, a.user.id, 5);
      await review(lesson.id, b.user.id, 4);
      // Hidden by moderation, so it must not drag the public average down.
      await review(lesson.id, moderated.user.id, 1, ReviewStatus.REJECTED);

      const rated = await lessons.getLessonStats(lesson.id);
      expect(rated.averageRating).toBe(4.5);
      expect(rated.reviewCount).toBe(2);
    });

    it('reports zeros for a lesson with no commerce at all, without inventing a rating', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Empty lesson');
      const lesson = await makeLesson(teacher.id, subject.id, 'Brand new', 750);

      const stats = await lessons.getLessonStats(lesson.id);

      expect(stats).toMatchObject({
        purchaseCount: 0,
        uniqueStudentCount: 0,
        studentsWithAccessCount: 0,
        completedCount: 0,
        totalRevenue: 0,
        grossRevenue: 0,
        refundedAmount: 0,
        averageRating: null,
        reviewCount: 0,
      });
    });

    it('reports unique students on lesson lists, not the order-counting denormalised column', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('List counts');
      const lesson = await makeLesson(teacher.id, subject.id, 'Listed', 300);
      const student = await makeStudent();

      const base = {
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 300,
      };
      // One student, two purchases (e.g. a renewal after expiry).
      await purchase(base);
      await purchase(base);

      // The denormalised counter incremented per order, so it now claims two
      // students where there is one. This is exactly the divergence that makes
      // it unusable as a "Students" column.
      const row = await dataSource.getRepository(Lesson).findOneByOrFail({ id: lesson.id });
      expect(row.students_count).toBe(2);

      const list = await lessons.findAll({ page: 1, limit: 20 });
      expect(list.data.find((item) => item.id === lesson.id)?.students_count).toBe(1);

      const detail = await lessons.findOne(lesson.id);
      expect(detail.students_count).toBe(1);
    });
  });

  /* ────────────────────────────── package stats ─────────────────────────── */

  describe('course stats', () => {
    it('aggregates every course version but counts a re-purchasing student once', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Course versions');
      const lessonA = await makeLesson(teacher.id, subject.id, 'A', 500);
      const pkg = await makePackage(teacher.id, subject.id, [lessonA.id], 1000);

      const loyal = await makeStudent();
      const other = await makeStudent();

      const base = {
        teacherId: teacher.id,
        itemType: ItemType.PACKAGE,
        itemId: pkg.id,
        listMajor: 1000,
      };
      // First sale locks version 1.
      await purchase({ ...base, studentId: loyal.user.id });

      // Curriculum change opens version 2; the same student buys again.
      const lessonB = await makeLesson(teacher.id, subject.id, 'B', 500);
      await packages.addLessons(pkg.id, teacher.id, {
        lessons: [{ lessonId: lessonB.id, orderIndex: 1 }],
      });
      await purchase({ ...base, studentId: loyal.user.id });
      await purchase({ ...base, studentId: other.user.id });

      const stats = await packages.getPackageStats(pkg.id);

      expect(stats.total_purchases).toBe(3);
      // Two humans, three orders: buying a newer version is not a new student.
      expect(stats.unique_students).toBe(2);
      expect(stats.students_with_access).toBe(2);
      expect(stats.purchased_version_count).toBeGreaterThanOrEqual(2);
      expect(stats.gross_revenue).toBe(3000);
      expect(stats.total_revenue).toBe(3000);
    });

    it('applies discounts and refunds to course revenue', async () => {
      const admin = await makeUser(UserRole.ADMIN);
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Course finance');
      const lesson = await makeLesson(teacher.id, subject.id, 'Inside', 500);
      const pkg = await makePackage(teacher.id, subject.id, [lesson.id], 2000);

      const paidFull = await makeStudent();
      const paidDiscounted = await makeStudent();
      const refundedStudent = await makeStudent();
      const abandoned = await makeStudent();

      const base = {
        teacherId: teacher.id,
        itemType: ItemType.PACKAGE,
        itemId: pkg.id,
        listMajor: 2000,
      };
      await purchase({ ...base, studentId: paidFull.user.id });
      await purchase({ ...base, studentId: paidDiscounted.user.id, discountMajor: 500 });
      const toRefund = await purchase({ ...base, studentId: refundedStudent.user.id });
      await unpaidOrder({
        ...base,
        studentId: abandoned.user.id,
        status: OrderStatus.AWAITING_PAYMENT,
      });

      await refund(toRefund.order.id, 200_000, admin.id);

      const stats = await packages.getPackageStats(pkg.id);

      expect(stats.total_purchases).toBe(3);
      expect(stats.unique_students).toBe(3);
      // Access was revoked for the fully-refunded buyer.
      expect(stats.students_with_access).toBe(2);
      expect(stats.gross_revenue).toBe(5500);
      expect(stats.discount_amount).toBe(500);
      expect(stats.refunded_amount).toBe(2000);
      expect(stats.total_revenue).toBe(3500);
    });

    it('rates a course from the approved reviews of its lessons, and null when there are none', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Course rating');
      const lessonA = await makeLesson(teacher.id, subject.id, 'A', 100);
      const lessonB = await makeLesson(teacher.id, subject.id, 'B', 100);
      const pkg = await makePackage(teacher.id, subject.id, [lessonA.id, lessonB.id], 300);

      const unrated = await packages.getPackageStats(pkg.id);
      expect(unrated.average_rating).toBeNull();
      expect(unrated.review_count).toBe(0);

      const s1 = await makeStudent();
      const s2 = await makeStudent();
      await review(lessonA.id, s1.user.id, 5);
      await review(lessonB.id, s2.user.id, 3);

      const rated = await packages.getPackageStats(pkg.id);
      expect(rated.average_rating).toBe(4);
      expect(rated.review_count).toBe(2);
    });
  });

  /* ────────────────────────────── student stats ─────────────────────────── */

  describe('student stats', () => {
    it('reports real purchases, progress and graded exams for an active student', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Student activity');
      const direct = await makeLesson(teacher.id, subject.id, 'Direct', 200);
      const bundled = await makeLesson(teacher.id, subject.id, 'Bundled', 200);
      const pkg = await makePackage(teacher.id, subject.id, [bundled.id], 600);
      const student = await makeStudent();

      await purchase({
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: direct.id,
        listMajor: 200,
      });
      await purchase({
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.PACKAGE,
        itemId: pkg.id,
        listMajor: 600,
      });

      const progress = dataSource.getRepository(LessonProgress);
      await progress.save(
        progress.create({
          student_id: student.user.id,
          lesson_id: direct.id,
          watched_duration: 600,
          total_duration: 600,
          progress_percent: 100,
          completed: true,
          last_watched_at: new Date(),
        }),
      );
      await progress.save(
        progress.create({
          student_id: student.user.id,
          lesson_id: bundled.id,
          watched_duration: 60,
          total_duration: 600,
          progress_percent: 10,
          completed: false,
          last_watched_at: new Date(),
        }),
      );

      const exam = await makeExam(teacher.id, subject.id);
      // 80% and 60% → a 70% average. Raw points would have said 70 out of a
      // meaningless scale; the percentage is what makes exams comparable.
      await makeAttempt(exam.id, student.user.id, 1, 80, 100, AttemptState.GRADED);
      await makeAttempt(exam.id, student.user.id, 2, 30, 50, AttemptState.GRADED);
      // Still open: not a completed exam, and must not enter the average.
      await makeAttempt(exam.id, student.user.id, 3, null, 100, AttemptState.IN_PROGRESS);

      const stats = await students.getStudentStats(student.profile.id);

      expect(stats).toEqual({
        lessonsPurchased: 2,
        lessonsCompleted: 1,
        coursesPurchased: 1,
        examsCompleted: 2,
        averageScore: 70,
      });
    });

    it('reports no-data as null rather than a zero that reads as failure', async () => {
      const student = await makeStudent();

      const stats = await students.getStudentStats(student.profile.id);

      expect(stats).toEqual({
        lessonsPurchased: 0,
        lessonsCompleted: 0,
        coursesPurchased: 0,
        examsCompleted: 0,
        averageScore: null,
      });
    });

    it('resolves stats by user id as well as profile id', async () => {
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Id resolution');
      const lesson = await makeLesson(teacher.id, subject.id, 'Any', 100);
      const student = await makeStudent();

      await purchase({
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 100,
      });

      // Both lookups must land on the same underlying user, or one of the two
      // callers (admin route vs. student profile route) silently reads zeros.
      await expect(students.getStudentStats(student.profile.id)).resolves.toMatchObject({
        lessonsPurchased: 1,
      });
      await expect(students.getStudentStats(student.user.id)).resolves.toMatchObject({
        lessonsPurchased: 1,
      });
    });

    it('drops access revoked by a full refund from the purchased counts', async () => {
      const admin = await makeUser(UserRole.ADMIN);
      const teacher = await makeUser(UserRole.TEACHER);
      const subject = await makeSubject('Refunded student');
      const kept = await makeLesson(teacher.id, subject.id, 'Kept', 100);
      const lost = await makeLesson(teacher.id, subject.id, 'Lost', 100);
      const student = await makeStudent();

      await purchase({
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: kept.id,
        listMajor: 100,
      });
      const refunded = await purchase({
        studentId: student.user.id,
        teacherId: teacher.id,
        itemType: ItemType.LESSON,
        itemId: lost.id,
        listMajor: 100,
      });
      await refund(refunded.order.id, 10_000, admin.id);

      await expect(students.getStudentStats(student.profile.id)).resolves.toMatchObject({
        lessonsPurchased: 1,
      });
    });
  });

  /* ──────────────────────────────── subjects ────────────────────────────── */

  describe('subject teachers and counts', () => {
    it('lists exactly the teachers linked to the subject', async () => {
      const subjectA = await makeSubject('Subject A');
      const subjectB = await makeSubject('Subject B');

      const first = await makeUser(UserRole.TEACHER);
      const second = await makeUser(UserRole.TEACHER);
      const elsewhere = await makeUser(UserRole.TEACHER);
      await makeTeacherProfile(first, [subjectA.id]);
      await makeTeacherProfile(second, [subjectA.id]);
      await makeTeacherProfile(elsewhere, [subjectB.id]);

      const result = await subjects.findTeachersBySubject(subjectA.id, 1, 20);

      expect(result.meta.total).toBe(2);
      expect(result.data.map((row) => row['name']).sort()).toEqual(
        [first.name, second.name].sort(),
      );
      expect(result.data.map((row) => row['name'])).not.toContain(elsewhere.name);
    });

    it('excludes teachers who are not publicly visible, and never leaks private fields', async () => {
      const subject = await makeSubject('Visibility');
      const approved = await makeUser(UserRole.TEACHER);
      const pending = await makeUser(UserRole.TEACHER, UserStatus.PENDING);
      await makeTeacherProfile(approved, [subject.id]);
      await makeTeacherProfile(pending, [subject.id]);

      const result = await subjects.findTeachersBySubject(subject.id, 1, 20);

      expect(result.meta.total).toBe(1);
      expect(result.data[0]?.['name']).toBe(approved.name);
      expect(JSON.stringify(result.data)).not.toMatch(/@example\.test|email|phone|status/i);
    });

    it('counts teachers, lessons and courses per subject from the real relations', async () => {
      const subjectA = await makeSubject('Counted A');
      const subjectB = await makeSubject('Counted B');
      const teacherOne = await makeUser(UserRole.TEACHER);
      const teacherTwo = await makeUser(UserRole.TEACHER);
      const teacherElsewhere = await makeUser(UserRole.TEACHER);
      await makeTeacherProfile(teacherOne, [subjectA.id]);
      await makeTeacherProfile(teacherTwo, [subjectA.id]);
      await makeTeacherProfile(teacherElsewhere, [subjectB.id]);

      const lessonOne = await makeLesson(teacherOne.id, subjectA.id, 'A1', 100);
      await makeLesson(teacherOne.id, subjectA.id, 'A2', 100, LessonStatus.DRAFT);
      await makeLesson(teacherElsewhere.id, subjectB.id, 'B1', 100);
      await makePackage(teacherOne.id, subjectA.id, [lessonOne.id], 300);

      const counts = await subjects.getSubjectsWithCounts();
      const a = counts.find((row) => row.id === subjectA.id);
      const b = counts.find((row) => row.id === subjectB.id);

      // Each field is asserted independently so a query that happens to return
      // the same number for two of them cannot pass unnoticed.
      expect(a?.teachersCount).toBe(2);
      expect(a?.lessonsCount).toBe(2);
      expect(a?.coursesCount).toBe(1);
      expect(b?.teachersCount).toBe(1);
      expect(b?.lessonsCount).toBe(1);
      expect(b?.coursesCount).toBe(0);
    });

    it('leaves a subject with no relations at genuine zero', async () => {
      const empty = await makeSubject('Empty subject');

      const counts = await subjects.getSubjectsWithCounts();
      const row = counts.find((entry) => entry.id === empty.id);

      expect(row).toMatchObject({ teachersCount: 0, lessonsCount: 0, coursesCount: 0 });
    });

    it('does not double-count a teacher linked through several subjects', async () => {
      const subjectA = await makeSubject('Multi A');
      const subjectB = await makeSubject('Multi B');
      const teacher = await makeUser(UserRole.TEACHER);
      await makeTeacherProfile(teacher, [subjectA.id, subjectB.id]);

      const counts = await subjects.getSubjectsWithCounts();

      expect(counts.find((row) => row.id === subjectA.id)?.teachersCount).toBe(1);
      expect(counts.find((row) => row.id === subjectB.id)?.teachersCount).toBe(1);
    });
  });

  /* ──────────────────────────────── teachers ────────────────────────────── */

  describe('teacher stats', () => {
    it('nets refunds out of teacher earnings and rates from approved reviews', async () => {
      const admin = await makeUser(UserRole.ADMIN);
      const teacherUser = await makeUser(UserRole.TEACHER);
      const profile = await makeTeacherProfile(teacherUser);
      const subject = await makeSubject('Teacher stats');
      const lesson = await makeLesson(teacherUser.id, subject.id, 'Sold', 1000);

      const buyer = await makeStudent();
      const refundedBuyer = await makeStudent();

      await purchase({
        studentId: buyer.user.id,
        teacherId: teacherUser.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 1000,
      });
      const toRefund = await purchase({
        studentId: refundedBuyer.user.id,
        teacherId: teacherUser.id,
        itemType: ItemType.LESSON,
        itemId: lesson.id,
        listMajor: 1000,
      });
      await refund(toRefund.order.id, 100_000, admin.id);

      const reviews = dataSource.getRepository(TeacherReview);
      await reviews.save(
        reviews.create({
          teacher_id: teacherUser.id,
          student_id: buyer.user.id,
          rating: 4,
          comment: null,
          status: ReviewStatus.APPROVED,
        }),
      );

      const stats = await teachers.getTeacherStats(profile.id);

      expect(stats.lessonsCount).toBe(1);
      expect(stats.studentsCount).toBe(2);
      // 70% of 1000 EGP kept, 70% of the refunded 1000 reversed → 70000 minor.
      expect(stats.totalEarnings).toBe(70_000);
      expect(stats.currency).toBe('EGP');
      expect(stats.averageRating).toBe(4);
      expect(stats.reviewCount).toBe(1);
    });

    it('reports an unreviewed teacher as unrated rather than zero stars', async () => {
      const teacherUser = await makeUser(UserRole.TEACHER);
      const profile = await makeTeacherProfile(teacherUser);

      const stats = await teachers.getTeacherStats(profile.id);

      expect(stats.averageRating).toBeNull();
      expect(stats.reviewCount).toBe(0);
      expect(stats.totalEarnings).toBe(0);
    });
  });

  /* ─────────────────────────────── exam helpers ─────────────────────────── */

  async function makeExam(teacherId: string, subjectId: string): Promise<Exam> {
    const repo = dataSource.getRepository(Exam);
    return repo.save(
      repo.create({
        title: `Exam ${String(++suffix)}`,
        title_ar: `امتحان ${String(suffix)}`,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        status: ExamStatus.PUBLISHED,
        config: DEFAULT_EXAM_CONFIG,
      }),
    );
  }

  async function makeAttempt(
    examId: string,
    studentId: string,
    attemptNumber: number,
    scoreTotal: number | null,
    maxScore: number,
    state: AttemptState,
  ): Promise<ExamAttempt> {
    const repo = dataSource.getRepository(ExamAttempt);
    const now = new Date();
    return repo.save(
      repo.create({
        exam_id: examId,
        student_id: studentId,
        attempt_number: attemptNumber,
        state,
        shuffle_seed: 0,
        started_at: now,
        deadline_at: new Date(now.getTime() + 3_600_000),
        submitted_at: state === AttemptState.IN_PROGRESS ? null : now,
        auto_submitted: false,
        graded_at: state === AttemptState.GRADED ? now : null,
        score_auto: scoreTotal,
        score_manual: null,
        score_total: scoreTotal,
        max_score: maxScore,
        passed: scoreTotal === null ? null : scoreTotal / maxScore >= 0.5,
        session_token: crypto.randomUUID(),
        idempotency_key: null,
      }),
    );
  }
});
