import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonProgress } from '../../src/lessons/entities/lesson-progress.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import {
  CollectionParty,
  Entitlement,
  EntitlementStatus,
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
import { PaymentsService } from '../../src/payments/services/payments.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { API_PREFIX, createAuthenticatedUser, createE2EApp, resetDatabase } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

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
        provider_order_reference: null,
        provider_transaction_id: null,
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

    await expect(payments.hasLessonPlaybackAccess(student.id, expiredLesson.id)).resolves.toBe(
      false,
    );
    await expect(payments.hasLessonPlaybackAccess(student.id, activeLesson.id)).resolves.toBe(true);
  });

  /**
   * T065 (W4-C1): the batched playback filter must equal the per-lesson predicate
   * for every access path, and `GET /student/lessons/my/progress` must return
   * exactly the rows the per-row filter would, in the same order. Free preview,
   * package ownership without a materialised lesson purchase, and
   * `entitlements.revoked_at` alone must NOT grant visibility.
   */
  describe('batched playback filter (T065)', () => {
    const DAY = 24 * 60 * 60_000;
    let authAgent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'];

    async function seed(): Promise<{
      studentId: string;
      otherId: string;
      lessonIds: Map<string, string>;
      expected: Map<string, boolean>;
    }> {
      const users = dataSource.getRepository(User);
      const makeUser = async (suffix: string, role: UserRole): Promise<User> =>
        users.save(
          users.create({
            username: `t065-${suffix}`,
            name: `T065 ${suffix}`,
            first_name: null,
            last_name: null,
            email: `t065-${suffix}@example.test`,
            phone: `0127${suffix.padStart(7, '0')}`,
            role,
            status: UserStatus.APPROVED,
            is_active: true,
            password_hash: null,
          }),
        );
      const teacher = await makeUser('1', UserRole.TEACHER);
      const other = await makeUser('3', UserRole.STUDENT);
      // The authenticated student is created through the real register/login flow.
      const auth = await createAuthenticatedUser(app, dataSource, { role: 'student' });
      const studentId = auth.userId;
      authAgent = auth.agent;

      const subjects = dataSource.getRepository(Subject);
      const subject = await subjects.save(
        subjects.create({
          name: 'T065 subject',
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
      const lessonRepo = dataSource.getRepository(Lesson);
      const lessonIds = new Map<string, string>();
      const expected = new Map<string, boolean>();
      const lessonFor = async (
        key: string,
        allowed: boolean,
        freePreview = false,
      ): Promise<string> => {
        expected.set(key, allowed);
        const lesson = await lessonRepo.save(
          lessonRepo.create({
            title: `T065 ${key}`,
            description: null,
            teacher_id: teacher.id,
            subject_id: subject.id,
            thumbnail: null,
            price: 100,
            duration: 600,
            is_group: true,
            available_for_days: 30,
            students_count: 0,
            is_free_preview: freePreview,
          }),
        );
        lessonIds.set(key, lesson.id);
        return lesson.id;
      };

      const paymentRepo = dataSource.getRepository(Payment);
      const orderRepo = dataSource.getRepository(Order);
      const entitlementRepo = dataSource.getRepository(Entitlement);
      const purchaseRepo = dataSource.getRepository(LessonPurchase);
      let seq = 0;
      const makePayment = async (
        userId: string,
        itemType: ItemType,
        itemId: string,
      ): Promise<{ payment: Payment; order: Order }> => {
        seq += 1;
        const order = await orderRepo.save(
          orderRepo.create({
            order_number: `T065-${seq}-${randomUUID().slice(0, 8)}`,
            student_id: userId,
            teacher_id: teacher.id,
            item_type: itemType,
            item_id: itemId,
            quantity: 1,
            original_amount_minor: 10_000,
            discount_amount_minor: 0,
            final_amount_minor: 10_000,
            refunded_amount_minor: 0,
            currency: 'EGP',
            payment_channel: PaymentChannel.MANUAL,
            payment_method: PaymentMethod.MANUAL,
            status: OrderStatus.PAID,
            discount_code_id: null,
            activation_code_id: null,
            payment_id: null,
            collection_party: CollectionParty.PLATFORM,
            product_title_snapshot: 'T065',
            product_title_ar_snapshot: null,
            seller_name_snapshot: teacher.name,
            platform_commission_bps: 1_000,
            platform_commission_minor: 1_000,
            teacher_earning_minor: 9_000,
            gateway_fee_bps: 0,
            gateway_fee_minor: 0,
            discount_snapshot: null,
            metadata: null,
            expires_at: null,
            paid_at: new Date(),
            cancelled_at: null,
          }),
        );
        const payment = await paymentRepo.save(
          paymentRepo.create({
            order_id: order.id,
            user_id: userId,
            item_type: itemType,
            item_id: itemId,
            amount: 100,
            discount_amount: 0,
            final_amount: 100,
            amount_minor: 10_000,
            currency: 'EGP',
            channel: PaymentChannel.MANUAL,
            provider: null,
            provider_reference: `t065-${seq}`,
            status: PaymentStatus.COMPLETED,
            payment_method: PaymentMethod.MANUAL,
            provider_order_reference: null,
            provider_transaction_id: null,
            idempotency_key: `t065-payment-${seq}-${randomUUID()}`,
            failure_reason: null,
            completed_at: new Date(),
          }),
        );
        return { payment, order };
      };
      const entitle = async (
        userId: string,
        lessonId: string,
        over: { status?: EntitlementStatus; expires_at?: Date | null; revoked_at?: Date | null },
      ): Promise<void> => {
        const { payment, order } = await makePayment(userId, ItemType.LESSON, lessonId);
        const now = new Date();
        await entitlementRepo.save(
          entitlementRepo.create({
            student_id: userId,
            item_type: ItemType.LESSON,
            item_id: lessonId,
            order_id: order.id,
            payment_id: payment.id,
            source_channel: PaymentChannel.MANUAL,
            status: over.status ?? EntitlementStatus.ACTIVE,
            granted_at: now,
            starts_at: now,
            expires_at: over.expires_at ?? null,
            revoked_at: over.revoked_at ?? null,
            revocation_reason: null,
          }),
        );
      };
      const purchase = async (
        userId: string,
        lessonId: string,
        over: { access_expires_at: Date; revoked_at?: Date | null },
        paymentId?: string,
      ): Promise<void> => {
        const pid = paymentId ?? (await makePayment(userId, ItemType.LESSON, lessonId)).payment.id;
        await purchaseRepo.save(
          purchaseRepo.create({
            student_id: userId,
            lesson_id: lessonId,
            payment_id: pid,
            price_paid: 0,
            access_granted_at: new Date(Date.now() - 2 * DAY),
            access_expires_at: over.access_expires_at,
            days_extended: 0,
            revoked_at: over.revoked_at ?? null,
            revocation_reason: null,
          }),
        );
      };
      const future = (): Date => new Date(Date.now() + 10 * DAY);
      const past = (): Date => new Date(Date.now() - DAY);

      await entitle(studentId, await lessonFor('entitlement-active', true), {});
      await entitle(studentId, await lessonFor('entitlement-expired', false), {
        expires_at: past(),
      });
      await entitle(studentId, await lessonFor('entitlement-revoked-status', false), {
        status: EntitlementStatus.REVOKED,
        revoked_at: new Date(),
      });
      await entitle(studentId, await lessonFor('entitlement-future-expiry', true), {
        expires_at: future(),
      });
      // status ACTIVE with only revoked_at set: the entitlement branch keys on status, not revoked_at.
      await entitle(studentId, await lessonFor('entitlement-active-but-revoked-at-set', true), {
        revoked_at: new Date(),
      });
      await purchase(studentId, await lessonFor('purchase-live', true), {
        access_expires_at: future(),
      });
      await purchase(studentId, await lessonFor('purchase-expired', false), {
        access_expires_at: past(),
      });
      await purchase(studentId, await lessonFor('purchase-revoked', false), {
        access_expires_at: future(),
        revoked_at: new Date(),
      });

      // Package-derived access exists only as materialised lesson_purchases rows.
      const packageRepo = dataSource.getRepository(LessonPackage);
      const pkg = await packageRepo.save(
        packageRepo.create({
          title: 'T065 package',
          title_ar: 'T065 package',
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
      const pkgLive = await lessonFor('package-derived-live', true);
      const pkgExpired = await lessonFor('package-derived-expired', false);
      const pkgNoRow = await lessonFor('package-owned-no-purchase-row', false);
      const itemRepo = dataSource.getRepository(LessonPackageItem);
      await itemRepo.save([
        itemRepo.create({ package_id: pkg.id, lesson_id: pkgLive, order_index: 0 }),
        itemRepo.create({ package_id: pkg.id, lesson_id: pkgExpired, order_index: 1 }),
        itemRepo.create({ package_id: pkg.id, lesson_id: pkgNoRow, order_index: 2 }),
      ]);
      const pkgPayment = (await makePayment(studentId, ItemType.PACKAGE, pkg.id)).payment;
      await dataSource.getRepository(PackagePurchase).save(
        dataSource.getRepository(PackagePurchase).create({
          student_id: studentId,
          package_id: pkg.id,
          payment_id: pkgPayment.id,
          price_paid: 200,
          purchased_at: new Date(Date.now() - 2 * DAY),
          revoked_at: null,
          revocation_reason: null,
        }),
      );
      await purchase(studentId, pkgLive, { access_expires_at: future() }, pkgPayment.id);
      await purchase(studentId, pkgExpired, { access_expires_at: past() }, pkgPayment.id);

      await lessonFor('free-preview-no-purchase', false, true);
      // An entitlement AND two purchases for one lesson: the id must appear once.
      const doubleLesson = await lessonFor('double-live', true);
      await entitle(studentId, doubleLesson, {});
      await purchase(studentId, doubleLesson, { access_expires_at: future() });
      await purchase(studentId, doubleLesson, { access_expires_at: future() });
      // Another student's purchase of a lesson this student never bought.
      await purchase(other.id, await lessonFor('other-students-purchase', false), {
        access_expires_at: future(),
      });
      await lessonFor('no-access-at-all', false);

      // One progress row per lesson with distinct last_watched_at so the order is observable.
      const progressRepo = dataSource.getRepository(LessonProgress);
      let minute = 0;
      for (const lessonId of lessonIds.values()) {
        minute += 1;
        await progressRepo.save(
          progressRepo.create({
            student_id: studentId,
            lesson_id: lessonId,
            watched_duration: 10,
            total_duration: 600,
            progress_percent: 1,
            completed: false,
            completed_at: null,
            last_watched_at: new Date(Date.UTC(2026, 0, 1, 0, minute)),
          }),
        );
      }
      return { studentId, otherId: other.id, lessonIds, expected };
    }

    it('batch.has(id) === hasLessonPlaybackAccess(id) for every access path, and equals the documented rule', async () => {
      const { studentId, otherId, lessonIds, expected } = await seed();
      const all = [...lessonIds.values()];

      const batch = await payments.getPlaybackAccessibleLessonIds(studentId, all);

      for (const [key, id] of lessonIds) {
        const perRow = await payments.hasLessonPlaybackAccess(studentId, id);
        expect({ key, batch: batch.has(id) }).toEqual({ key, batch: perRow });
        expect({ key, allowed: batch.has(id) }).toEqual({ key, allowed: expected.get(key) });
      }
      expect(batch.size).toBe([...expected.values()].filter(Boolean).length);
      await expect(payments.getPlaybackAccessibleLessonIds(studentId, [])).resolves.toEqual(
        new Set(),
      );
      // Another student's access is computed for that student only.
      const otherSet = await payments.getPlaybackAccessibleLessonIds(otherId, all);
      expect([...otherSet]).toEqual([lessonIds.get('other-students-purchase')]);
    });

    it('GET /student/lessons/my/progress returns the per-row filter rows in the same order, with no per-row probes', async () => {
      const { studentId, lessonIds } = await seed();
      const progress = await dataSource
        .getRepository(LessonProgress)
        .createQueryBuilder('p')
        .where('p.student_id = :studentId', { studentId })
        .orderBy('p.last_watched_at', 'DESC')
        .getMany();
      const oracle: string[] = [];
      for (const row of progress) {
        if (await payments.hasLessonPlaybackAccess(studentId, row.lesson_id))
          oracle.push(row.lesson_id);
      }
      expect(oracle.length).toBeGreaterThan(5);

      const counter = new StatementCounter(dataSource);
      counter.start();
      const res = await authAgent
        .get(`${API_PREFIX}/student/lessons/my/progress`)
        .set('X-Request-Id', 't065-progress')
        .expect(200);
      counter.stop();

      const rows = res.body.data as { lessonId: string; lessonTitle: string }[];
      const ids = rows.map((r) => r.lessonId);
      expect(ids).toEqual(oracle);
      expect(new Set(ids).size).toBe(ids.length);
      const keyOf = (id: string): string | undefined =>
        [...lessonIds].find(([, value]) => value === id)?.[0];
      expect(rows.map((r) => r.lessonTitle)).toEqual(ids.map((id) => `T065 ${keyOf(id)}`));
      // Free-preview and package-without-row lessons stay hidden.
      expect(ids).not.toContain(lessonIds.get('free-preview-no-purchase'));
      expect(ids).not.toContain(lessonIds.get('package-owned-no-purchase-row'));

      // One progress statement and one access statement (which reads both tables); no per-row probes.
      const statements = counter.statements({ requestId: 't065-progress' });
      expect(counter.count({ requestId: 't065-progress', table: 'lesson_progress' })).toBe(1);
      expect(counter.count({ requestId: 't065-progress', table: 'lesson_purchases' })).toBe(1);
      expect(counter.count({ requestId: 't065-progress', table: 'entitlements' })).toBe(1);
      // Besides the auth guard's session lookup the handler issues exactly 2 statements (was 1 + P..2P).
      expect(
        statements.filter(
          (st) => !st.sql.includes('FROM "sessions"') && !st.sql.includes('"session"."id"'),
        ).length,
      ).toBe(2);
    });

    it('T074: checkItemAccess probes the entitlement once — entitled 1 statement, not entitled 2 — with unchanged answers', async () => {
      const { studentId, lessonIds } = await seed();
      const run = async (itemType: ItemType, itemId: string) => {
        const counter = new StatementCounter(dataSource);
        counter.start();
        const result = await payments.checkItemAccess(studentId, itemType, itemId);
        counter.stop();
        return { result, statements: counter.count() };
      };

      // Active entitlement: found by the first (and only) entitlement probe.
      const entitled = await run(ItemType.LESSON, lessonIds.get('entitlement-active')!);
      expect(entitled.result).toEqual({ has_access: true });
      expect(entitled.statements).toBe(1);

      // Expired / revoked entitlement and no purchase: entitlement probe + the purchase fallback (was 3).
      for (const key of ['entitlement-expired', 'entitlement-revoked-status', 'no-access-at-all']) {
        const denied = await run(ItemType.LESSON, lessonIds.get(key)!);
        expect({ key, ...denied }).toEqual({ key, result: { has_access: false }, statements: 2 });
      }

      // A live purchase with no entitlement is still honoured by the legacy fallback.
      const legacy = await run(ItemType.LESSON, lessonIds.get('purchase-live')!);
      expect(legacy.result).toMatchObject({ has_access: true });
      expect(legacy.statements).toBe(2);

      // Package and book fallbacks: entitlement probe + their own purchase read.
      expect(await run(ItemType.PACKAGE, randomUUID())).toEqual({
        result: { has_access: false },
        statements: 2,
      });
      expect(await run(ItemType.BOOK, randomUUID())).toEqual({
        result: { has_access: false },
        statements: 2,
      });
    });
  });
});
