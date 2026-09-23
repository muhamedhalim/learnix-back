import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../../src/lessons/entities/lesson.entity';
import {
  ItemType,
  LessonPurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../../src/payments/entities';
import { Subject } from '../../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../../src/users/entities';
import { UserStatus } from '../../../src/users/entities/user-status.enum';
import { createAuthenticatedUser, type AuthenticatedUser } from './auth';

/**
 * An approved, logged-in student holding a live purchase of a published
 * (600 s) lesson, so `POST /student/lessons/:lessonId/progress` succeeds.
 * Same fixture shape as `lesson-session-enter.postgres.e2e-spec.ts`, with
 * unique identifiers so it can be created more than once per database.
 *
 * Writes go straight to the database (no HTTP), so building it invalidates no
 * cache generation.
 */
export async function createEnrolledStudent(
  app: INestApplication,
  dataSource: DataSource,
): Promise<{ student: AuthenticatedUser; lesson: Lesson }> {
  const student = await createAuthenticatedUser(app, dataSource);
  const tag = randomUUID().slice(0, 8);

  const users = dataSource.getRepository(User);
  const teacher = await users.save(
    users.create({
      username: `enrolled-teacher-${tag}`,
      name: 'Enrolled Student Fixture Teacher',
      first_name: null,
      last_name: null,
      email: `enrolled-teacher-${tag}@example.test`,
      phone: `0127${Math.floor(1_000_000 + Math.random() * 8_999_999).toString()}`,
      role: UserRole.TEACHER,
      status: UserStatus.APPROVED,
      is_active: true,
      password_hash: null,
    }),
  );

  const subjects = dataSource.getRepository(Subject);
  const subject = await subjects.save(
    subjects.create({
      name: `Enrolled fixture subject ${tag}`,
      description: null,
      description_ar: null,
      status: SubjectStatus.APPROVED,
      created_by_teacher_id: null,
      rejection_reason: null,
      reviewed_by_admin_id: null,
      reviewed_at: null,
    }),
  );

  const lessons = dataSource.getRepository(Lesson);
  const lesson = await lessons.save(
    lessons.create({
      title: 'Enrolled fixture lesson',
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

  const payments = dataSource.getRepository(Payment);
  const payment = await payments.save(
    payments.create({
      order_id: null,
      user_id: student.userId,
      item_type: ItemType.LESSON,
      item_id: lesson.id,
      amount: 100,
      discount_amount: 0,
      final_amount: 100,
      amount_minor: 10_000,
      currency: 'EGP',
      channel: PaymentChannel.MANUAL,
      provider: null,
      provider_reference: `enrolled-${tag}`,
      status: PaymentStatus.COMPLETED,
      payment_method: PaymentMethod.MANUAL,
      idempotency_key: `enrolled-${randomUUID()}`,
    }),
  );

  const purchases = dataSource.getRepository(LessonPurchase);
  const grantedAt = new Date();
  await purchases.save(
    purchases.create({
      student_id: student.userId,
      lesson_id: lesson.id,
      payment_id: payment.id,
      price_paid: 100,
      access_granted_at: grantedAt,
      access_expires_at: new Date(grantedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      days_extended: 0,
      revoked_at: null,
      revocation_reason: null,
    }),
  );

  return { student, lesson };
}
