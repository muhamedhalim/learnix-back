import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { ParentEventType } from '../../src/common/events/parent-event-type.enum';
import {
  Guardian,
  GuardianRelationship,
  GuardianVerificationStatus,
  PreferredLanguage,
  StudentGuardian,
} from '../../src/guardians/entities';
import { GuardiansService } from '../../src/guardians/guardians.service';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import {
  ItemType,
  LessonPurchase,
  Payment,
  PaymentChannel,
  PaymentMethod,
  PaymentStatus,
} from '../../src/payments/entities';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { BroadcastScope } from '../../src/teacher-follow-up/dto/teacher-broadcast.dto';
import { TeacherBroadcastService } from '../../src/teacher-follow-up/teacher-broadcast.service';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * T068: the batched guardian lookup must return, for every student, exactly what the
 * single-student lookup returns, over rows that exercise every eligibility rule; and
 * the teacher broadcast preview must cost one guardian statement however many students
 * the audience has.
 */
describe('Guardian targets: batch equals single (postgres)', () => {
  let ctx: E2EContext;
  let guardiansService: GuardiansService;
  let broadcast: TeacherBroadcastService;
  let counter: StatementCounter;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createE2EApp();
    guardiansService = ctx.app.get(GuardiansService);
    broadcast = ctx.app.get(TeacherBroadcastService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;

  async function user(role: UserRole, tag: string): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `gtb-${tag}`,
        name: `GTB ${tag}`,
        first_name: null,
        last_name: null,
        email: `gtb-${tag}@example.test`,
        phone: `0125${String(seq).padStart(7, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function guardian(options: {
    verified?: boolean;
    optedOut?: boolean;
    deleted?: boolean;
  }): Promise<Guardian> {
    seq += 1;
    const guardians = ds().getRepository(Guardian);
    const saved = await guardians.save(
      guardians.create({
        phone_e164: `+2011${String(seq).padStart(8, '0')}`,
        full_name: `Guardian ${String(seq)}`,
        preferred_language: PreferredLanguage.AR,
        verification_status:
          options.verified === false
            ? GuardianVerificationStatus.UNVERIFIED
            : GuardianVerificationStatus.VERIFIED,
        verified_at: options.verified === false ? null : new Date(),
        whatsapp_capable: true,
        opted_out_at: options.optedOut === true ? new Date() : null,
      }),
    );
    if (options.deleted === true) await guardians.softDelete({ id: saved.id });
    return saved;
  }

  async function link(
    studentId: string,
    guardianId: string,
    options: {
      receives?: boolean;
      preferences?: Partial<Record<ParentEventType, boolean>>;
    } = {},
  ): Promise<void> {
    const links = ds().getRepository(StudentGuardian);
    await links.save(
      links.create({
        student_id: studentId,
        guardian_id: guardianId,
        relationship: GuardianRelationship.FATHER,
        is_primary: false,
        receives_notifications: options.receives ?? true,
        notification_preferences: options.preferences ?? {},
      }),
    );
  }

  async function seedGuardians(): Promise<string[]> {
    const students = await Promise.all(
      [
        'verified',
        'unverified',
        'opted-out',
        'master-off',
        'pref-false',
        'deleted',
        'shared-a',
        'shared-b',
        'none',
      ].map(async (tag) => user(UserRole.STUDENT, tag)),
    );
    const [verified, unverified, optedOut, masterOff, prefFalse, deleted, sharedA, sharedB] =
      students;
    await link(verified!.id, (await guardian({})).id);
    await link(unverified!.id, (await guardian({ verified: false })).id);
    await link(optedOut!.id, (await guardian({ optedOut: true })).id);
    await link(masterOff!.id, (await guardian({})).id, { receives: false });
    await link(prefFalse!.id, (await guardian({})).id, {
      preferences: {
        [ParentEventType.EXAM_GRADED]: false,
        [ParentEventType.TEACHER_MESSAGE]: false,
      },
    });
    await link(deleted!.id, (await guardian({ deleted: true })).id);
    // One guardian reaching two students, plus a second guardian on the first of them.
    const shared = await guardian({});
    await link(sharedA!.id, shared.id);
    await link(sharedB!.id, shared.id, { preferences: { [ParentEventType.EXAM_GRADED]: true } });
    await link(sharedA!.id, (await guardian({})).id);
    return students.map((student) => student.id);
  }

  it('returns the single lookup for every student and event kind, in one statement', async () => {
    const studentIds = await seedGuardians();

    for (const event of [
      ParentEventType.EXAM_GRADED,
      ParentEventType.TEACHER_MESSAGE,
      ParentEventType.LESSON_COMPLETED,
      ParentEventType.GUARDIAN_VERIFICATION,
    ]) {
      counter.start();
      const batch = await guardiansService.findNotificationTargetsForStudents(studentIds, event);
      counter.stop();
      expect(counter.count()).toBe(1);

      for (const studentId of studentIds) {
        const single = await guardiansService.findNotificationTargets(studentId, event);
        const sort = <T extends { guardian_id: string }>(rows: T[]): T[] =>
          [...rows].sort((a, b) => a.guardian_id.localeCompare(b.guardian_id));
        expect({ event, studentId, targets: sort(batch.get(studentId) ?? []) }).toEqual({
          event,
          studentId,
          targets: sort(single),
        });
      }
    }

    // Sanity on the documented rules, so a shared bug in both paths cannot hide.
    const exam = await guardiansService.findNotificationTargetsForStudents(
      studentIds,
      ParentEventType.EXAM_GRADED,
    );
    const counts = studentIds.map((id) => exam.get(id)?.length ?? 0);
    // verified 1, unverified 0, opted-out 0, master-off 0, pref-false 0, deleted 0, shared-a 2, shared-b 1, none 0
    expect(counts).toEqual([1, 0, 0, 0, 0, 0, 2, 1, 0]);
    const otp = await guardiansService.findNotificationTargetsForStudents(
      studentIds,
      ParentEventType.GUARDIAN_VERIFICATION,
    );
    // Transactional: unverified, opted-out, master-off and preference-off still addressable; deleted never.
    expect(studentIds.map((id) => otp.get(id)?.length ?? 0)).toEqual([1, 1, 1, 1, 1, 0, 2, 1, 0]);
  });

  it('broadcast preview costs one guardian statement for the whole audience', async () => {
    const teacher = await user(UserRole.TEACHER, 'teacher');
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'GTB subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const lessons = ds().getRepository(Lesson);
    const lesson = await lessons.save(
      lessons.create({
        title: 'GTB lesson',
        description: null,
        teacher_id: teacher.id,
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
    const studentIds = await seedGuardians();
    const payments = ds().getRepository(Payment);
    const purchases = ds().getRepository(LessonPurchase);
    for (const studentId of studentIds) {
      const payment = await payments.save(
        payments.create({
          order_id: null,
          user_id: studentId,
          item_type: ItemType.LESSON,
          item_id: lesson.id,
          amount: 0,
          discount_amount: 0,
          final_amount: 0,
          amount_minor: 0,
          currency: 'EGP',
          channel: PaymentChannel.MANUAL,
          provider: null,
          provider_reference: `gtb-${studentId}`,
          status: PaymentStatus.COMPLETED,
          payment_method: PaymentMethod.MANUAL,
          paymob_order_id: null,
          paymob_transaction_id: null,
          idempotency_key: `gtb-${randomUUID()}`,
          failure_reason: null,
          completed_at: new Date(),
        }),
      );
      await purchases.save(
        purchases.create({
          student_id: studentId,
          lesson_id: lesson.id,
          payment_id: payment.id,
          price_paid: 0,
          access_granted_at: new Date(),
          access_expires_at: new Date(Date.now() + 86_400_000),
          days_extended: 0,
          revoked_at: null,
          revocation_reason: null,
        }),
      );
    }

    counter.start();
    const preview = await broadcast.preview(teacher.id, {
      scope: BroadcastScope.CLASS,
      lessonId: lesson.id,
      message: 'Hello',
    } as never);
    counter.stop();

    // Oracle: the per-student lookup this replaces.
    const expectedReachable: string[] = [];
    for (const recipient of preview.recipients) {
      const single = await guardiansService.findNotificationTargets(
        recipient.studentId,
        ParentEventType.TEACHER_MESSAGE,
      );
      expect({ studentId: recipient.studentId, willReceive: recipient.willReceive }).toEqual({
        studentId: recipient.studentId,
        willReceive: single.length > 0,
      });
      if (single.length > 0) expectedReachable.push(recipient.studentId);
    }
    expect(preview.totalStudents).toBe(studentIds.length);
    expect(preview.studentsReachable).toBe(expectedReachable.length);
    // The guardian lookup (the only statement joining student_guardians) runs once for 9 students.
    expect(counter.count({ table: 'student_guardians' })).toBe(1);
  });
});
