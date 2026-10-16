import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { Exam } from '../../src/exams/entities/exam.entity';
import { ExamStatus } from '../../src/exams/entities/exam-status.enum';
import { ExamAccessService } from '../../src/exams/services/exam-access.service';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import {
  examAudienceStudentIds,
  homeworkAudienceStudentIds,
} from '../../src/payments/lesson-audience';
import {
  ItemType,
  LessonPurchase,
  PackagePurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';

jest.setTimeout(120_000);

/**
 * T075 (W4-C10): the exam notification audience equals the owner's per-kind rules AND, as a property,
 * every notified student can open the exam (notified implies findAccessibleExam succeeds).
 */
describe('Exam audience builder (postgres)', () => {
  let ctx: E2EContext;
  let access: ExamAccessService;

  beforeAll(async () => {
    ctx = await createE2EApp();
    access = ctx.app.get(ExamAccessService);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  const DAY = 86_400_000;
  let seq = 0;

  async function user(tag: string, role = UserRole.STUDENT): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `aud-${tag}`,
        name: `Aud ${tag}`,
        first_name: null,
        last_name: null,
        email: `aud-${tag}@example.test`,
        phone: `0126${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function payment(userId: string, itemType: ItemType, itemId: string): Promise<Payment> {
    const payments = ds().getRepository(Payment);
    return payments.save(
      payments.create({
        order_id: null,
        user_id: userId,
        item_type: itemType,
        item_id: itemId,
        amount: 0,
        discount_amount: 0,
        final_amount: 0,
        amount_minor: 0,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: `aud-${randomUUID()}`,
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        provider_order_reference: null,
        provider_transaction_id: null,
        idempotency_key: `aud-${randomUUID()}`,
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
  }

  async function lessonPurchase(
    studentId: string,
    lessonId: string,
    state: 'live' | 'expired' | 'revoked',
  ): Promise<void> {
    const pay = await payment(studentId, ItemType.LESSON, lessonId);
    const repo = ds().getRepository(LessonPurchase);
    await repo.save(
      repo.create({
        student_id: studentId,
        lesson_id: lessonId,
        payment_id: pay.id,
        price_paid: 0,
        access_granted_at: new Date(Date.now() - 2 * DAY),
        access_expires_at: new Date(Date.now() + (state === 'expired' ? -DAY : 10 * DAY)),
        days_extended: 0,
        revoked_at: state === 'revoked' ? new Date() : null,
        revocation_reason: null,
      }),
    );
  }

  async function packagePurchase(
    studentId: string,
    packageId: string,
    revoked = false,
  ): Promise<void> {
    const pay = await payment(studentId, ItemType.PACKAGE, packageId);
    const repo = ds().getRepository(PackagePurchase);
    await repo.save(
      repo.create({
        student_id: studentId,
        package_id: packageId,
        payment_id: pay.id,
        price_paid: 0,
        purchased_at: new Date(Date.now() - 2 * DAY),
        revoked_at: revoked ? new Date() : null,
        revocation_reason: null,
      }),
    );
  }

  it('matches the per-kind rules and never notifies a student who cannot open the exam', async () => {
    const teacher = await user('teacher', UserRole.TEACHER);
    const otherTeacher = await user('other-teacher', UserRole.TEACHER);
    const subject = await ds()
      .getRepository(Subject)
      .save(
        ds().getRepository(Subject).create({
          name: 'Aud subject',
          description: null,
          description_ar: null,
          status: SubjectStatus.APPROVED,
          created_by_teacher_id: null,
          rejection_reason: null,
          reviewed_by_admin_id: null,
          reviewed_at: null,
        }),
      );
    const lessonRepo = ds().getRepository(Lesson);
    const mkLesson = async (teacherId: string, title: string) =>
      lessonRepo.save(
        lessonRepo.create({
          title,
          description: null,
          teacher_id: teacherId,
          subject_id: subject.id,
          thumbnail: null,
          price: 0,
          duration: 600,
          is_group: true,
          available_for_days: 30,
          students_count: 0,
          is_free_preview: false,
        }),
      );
    const lessonA = await mkLesson(teacher.id, 'A');
    const lessonB = await mkLesson(teacher.id, 'B');
    const foreignLesson = await mkLesson(otherTeacher.id, 'Foreign');
    const packages = ds().getRepository(LessonPackage);
    const mkPackage = async (teacherId: string, title: string, lessonIds: string[]) => {
      const saved = await packages.save(
        packages.create({
          title,
          title_ar: title,
          description: null,
          description_ar: null,
          teacher_id: teacherId,
          subject_id: subject.id,
          price: 0,
          original_price: null,
          is_active: true,
          thumbnail: null,
          status: CourseStatus.PUBLISHED,
          published_at: new Date(),
        }),
      );
      const items = ds().getRepository(LessonPackageItem);
      await items.save(
        lessonIds.map((lessonId, i) =>
          items.create({ package_id: saved.id, lesson_id: lessonId, order_index: i }),
        ),
      );
      return saved;
    };
    const pkg = await mkPackage(teacher.id, 'Course', [lessonA.id]);
    const foreignPkg = await mkPackage(otherTeacher.id, 'Foreign course', [foreignLesson.id]);

    const s = {
      direct: await user('direct'),
      directExpired: await user('direct-expired'),
      directRevoked: await user('direct-revoked'),
      packageOnlyExpiredLesson: await user('pkg-expired-lesson'),
      packageLive: await user('pkg-live'),
      packageRevoked: await user('pkg-revoked'),
      rosterLesson: await user('roster-lesson'),
      rosterPackage: await user('roster-package'),
      foreignOnly: await user('foreign-only'),
      nobody: await user('nobody'),
    };
    await lessonPurchase(s.direct.id, lessonA.id, 'live');
    await lessonPurchase(s.directExpired.id, lessonA.id, 'expired');
    await lessonPurchase(s.directRevoked.id, lessonA.id, 'revoked');
    // Holds the package, but its derived lesson purchase for lesson A expired: package never bypasses the window.
    await packagePurchase(s.packageOnlyExpiredLesson.id, pkg.id);
    await lessonPurchase(s.packageOnlyExpiredLesson.id, lessonA.id, 'expired');
    await packagePurchase(s.packageLive.id, pkg.id);
    await lessonPurchase(s.packageLive.id, lessonA.id, 'live');
    await packagePurchase(s.packageRevoked.id, pkg.id, true);
    await lessonPurchase(s.rosterLesson.id, lessonB.id, 'live');
    await packagePurchase(s.rosterPackage.id, pkg.id);
    await lessonPurchase(s.foreignOnly.id, foreignLesson.id, 'live');
    await packagePurchase(s.foreignOnly.id, foreignPkg.id);

    const exams = ds().getRepository(Exam);
    const mkExam = async (over: Partial<Exam>): Promise<Exam> =>
      exams.save(
        exams.create({
          teacher_id: teacher.id,
          subject_id: subject.id,
          lesson_id: null,
          package_id: null,
          title: 'Audience exam',
          title_ar: 'اختبار',
          description: null,
          description_ar: null,
          is_public: false,
          status: ExamStatus.PUBLISHED,
          config: {},
          total_marks: 10,
          passing_marks: 5,
          ...over,
        } as never) as unknown as Exam,
      );
    const lessonExam = await mkExam({ lesson_id: lessonA.id });
    const packageExam = await mkExam({ package_id: pkg.id });
    const unscopedExam = await mkExam({});
    const publicExam = await mkExam({ is_public: true });

    const ids = async (exam: Exam): Promise<string[]> =>
      (await examAudienceStudentIds(ds(), exam, new Date())).sort();
    const named = (...students: User[]): string[] => students.map((x) => x.id).sort();

    // (a) lesson exam: live direct purchases only — no package-only holder, no expired or revoked one.
    expect(await ids(lessonExam)).toEqual(named(s.direct, s.packageLive));
    // (b)... package exam: unrevoked package purchases (revoked excluded).
    expect(await ids(packageExam)).toEqual(
      named(s.packageOnlyExpiredLesson, s.packageLive, s.rosterPackage),
    );
    // (c) unscoped exam: the teacher roster rule.
    expect(await ids(unscopedExam)).toEqual(
      named(s.direct, s.packageOnlyExpiredLesson, s.packageLive, s.rosterLesson, s.rosterPackage),
    );
    // (e) public exam: nobody.
    expect(await ids(publicExam)).toEqual([]);

    // The invariant, for every exam kind and every student: notified implies can open.
    const everyone = Object.values(s);
    for (const exam of [lessonExam, packageExam, unscopedExam, publicExam]) {
      const notified = new Set(await ids(exam));
      for (const student of everyone) {
        const canOpen = await access.findAccessibleExam(student.id, exam.id).then(
          () => true,
          () => false,
        );
        if (notified.has(student.id))
          expect({ exam: exam.id, student: student.id, canOpen }).toMatchObject({ canOpen: true });
      }
    }

    // Homework (decision (e)): live direct lesson purchases only, whatever the packages say.
    const homework = (await homeworkAudienceStudentIds(ds(), lessonA.id, new Date())).sort();
    expect(homework).toEqual(named(s.direct, s.packageLive));
  });
});
