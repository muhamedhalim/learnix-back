import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import {
  ItemType,
  LessonPurchase,
  PackagePurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { PaymentsService } from '../../src/payments/services/payments.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase } from './fixtures';

describe('package lesson access windows (PostgreSQL)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let payments: PaymentsService;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    payments = app.get(PaymentsService);
  });
  beforeEach(async () => resetDatabase(dataSource));
  afterAll(async () => app.close());

  it('does not let package ownership bypass one expired lesson while another remains active', async () => {
    const users = dataSource.getRepository(User);
    const makeUser = async (suffix: string, role: UserRole) =>
      users.save(
        users.create({
          username: `package-window-${suffix}`,
          name: `Package Window ${suffix}`,
          first_name: null,
          last_name: null,
          email: `package-window-${suffix}@example.test`,
          phone: `01266${suffix.padStart(6, '0')}`,
          role,
          status: UserStatus.APPROVED,
          is_active: true,
          password_hash: null,
        }),
      );
    const teacher = await makeUser('1', UserRole.TEACHER);
    const student = await makeUser('2', UserRole.STUDENT);
    const subjects = dataSource.getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'Package access subject',
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
    const lessons = dataSource.getRepository(Lesson);
    const expiredLesson = await lessons.save(
      lessons.create({
        title: 'Expired package lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 100,
        duration: 600,
        is_group: true,
        available_for_days: 1,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const activeLesson = await lessons.save(
      lessons.create({
        title: 'Active package lesson',
        description: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        thumbnail: null,
        price: 100,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
    const packages = dataSource.getRepository(LessonPackage);
    const pkg = await packages.save(
      packages.create({
        title: 'Mixed access package',
        title_ar: 'Mixed access package',
        description: null,
        description_ar: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        price: 200,
        original_price: null,
        is_active: true,
        thumbnail: null,
        status: CourseStatus.PUBLISHED,
        published_at: new Date(),
      }),
    );
    const packageItems = dataSource.getRepository(LessonPackageItem);
    await packageItems.save([
      packageItems.create({ package_id: pkg.id, lesson_id: expiredLesson.id, order_index: 0 }),
      packageItems.create({ package_id: pkg.id, lesson_id: activeLesson.id, order_index: 1 }),
    ]);

    const paymentRepository = dataSource.getRepository(Payment);
    const payment = await paymentRepository.save(
      paymentRepository.create({
        order_id: null,
        user_id: student.id,
        item_type: ItemType.PACKAGE,
        item_id: pkg.id,
        amount: 200,
        discount_amount: 0,
        final_amount: 200,
        amount_minor: 20_000,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: 'package-window-e2e',
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        paymob_order_id: null,
        paymob_transaction_id: null,
        idempotency_key: 'package-window-e2e-payment',
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
    const purchasedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await dataSource.getRepository(PackagePurchase).save(
      dataSource.getRepository(PackagePurchase).create({
        student_id: student.id,
        package_id: pkg.id,
        payment_id: payment.id,
        price_paid: 200,
        purchased_at: purchasedAt,
        revoked_at: null,
        revocation_reason: null,
      }),
    );
    const lessonPurchases = dataSource.getRepository(LessonPurchase);
    await lessonPurchases.save([
      lessonPurchases.create({
        student_id: student.id,
        lesson_id: expiredLesson.id,
        payment_id: payment.id,
        price_paid: 0,
        access_granted_at: purchasedAt,
        access_expires_at: new Date(Date.now() - 24 * 60 * 60_000),
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      }),
      lessonPurchases.create({
        student_id: student.id,
        lesson_id: activeLesson.id,
        payment_id: payment.id,
        price_paid: 0,
        access_granted_at: purchasedAt,
        access_expires_at: new Date(Date.now() + 28 * 24 * 60 * 60_000),
        days_extended: 0,
        revoked_at: null,
        revocation_reason: null,
      }),
    ]);

    await expect(payments.hasLessonPlaybackAccess(student.id, expiredLesson.id)).resolves.toBe(false);
    await expect(payments.hasLessonPlaybackAccess(student.id, activeLesson.id)).resolves.toBe(true);
  });
});
