import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { AnalyticsService } from '../../src/analytics/analytics.service';
import { LessonSession } from '../../src/attendance/entities/lesson-session.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
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
import { LessonReview } from '../../src/reviews/entities/lesson-review.entity';
import { ReviewStatus } from '../../src/reviews/entities/review-status.enum';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { createE2EApp, resetDatabase, type E2EContext } from './fixtures';
import { StatementCounter } from './helpers/statement-counter';

/**
 * T056 parity: batch[i] must deep-equal getLessonAnalytics(id) except
 * `calculated_at`, over a fixture that includes the hidden filters (soft-deleted
 * package purchase, a lesson in two packages bought by one student, refunded and
 * unpaid orders, pending reviews). The batch cost is independent of N.
 */
describe('Lesson analytics batch (parity, postgres)', () => {
  let ctx: E2EContext;
  let service: AnalyticsService;
  let counter: StatementCounter;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createE2EApp();
    service = ctx.app.get(AnalyticsService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;

  async function user(role: UserRole, tag: string): Promise<User> {
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `lab-${tag}`,
        name: `lab ${tag}`,
        first_name: null,
        last_name: null,
        email: `lab-${tag}@example.test`,
        phone: `0115${Math.floor(1_000_000 + Math.random() * 8_999_999).toString()}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function payment(
    userId: string,
    itemType: ItemType,
    itemId: string,
    status: PaymentStatus = PaymentStatus.COMPLETED,
    orderId: string | null = null,
  ): Promise<Payment> {
    const payments = ds().getRepository(Payment);
    const id = randomUUID();
    return payments.save(
      payments.create({
        order_id: orderId,
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
        provider_reference: `lab-${id}`,
        status,
        payment_method: PaymentMethod.MANUAL,
        idempotency_key: `lab-${id}`,
      }),
    );
  }

  async function lesson(teacherId: string, subjectId: string, title: string): Promise<Lesson> {
    const lessons = ds().getRepository(Lesson);
    return lessons.save(
      lessons.create({
        title,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 100,
        duration: 600,
        is_group: true,
        available_for_days: 30,
        students_count: 0,
        is_free_preview: false,
      }),
    );
  }

  async function lessonOrder(
    teacherId: string,
    studentId: string,
    lessonId: string,
    amount: number,
    status: OrderStatus,
    completed: boolean,
  ): Promise<void> {
    seq += 1;
    const orders = ds().getRepository(Order);
    const saved = await orders.save(
      orders.create({
        order_number: `LAB-${String(seq)}`,
        student_id: studentId,
        teacher_id: teacherId,
        item_type: ItemType.LESSON,
        item_id: lessonId,
        quantity: 1,
        original_amount_minor: amount,
        discount_amount_minor: 0,
        final_amount_minor: amount,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: null,
        status,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        cart_checkout_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'lab',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: 0,
        teacher_earning_minor: amount,
        gateway_fee_bps: 0,
        gateway_fee_minor: 0,
        discount_snapshot: null,
        metadata: {},
        expires_at: null,
        paid_at: status === OrderStatus.AWAITING_PAYMENT ? null : new Date(),
        cancelled_at: null,
      }),
    );
    const pay = await payment(
      studentId,
      ItemType.LESSON,
      lessonId,
      completed ? PaymentStatus.COMPLETED : PaymentStatus.PROCESSING,
      saved.id,
    );
    await orders.update({ id: saved.id }, { payment_id: pay.id });
  }

  async function seed() {
    const teacher = await user(UserRole.TEACHER, 'owner');
    const other = await user(UserRole.TEACHER, 'other');
    const s1 = await user(UserRole.STUDENT, 's1');
    const s2 = await user(UserRole.STUDENT, 's2');
    const s3 = await user(UserRole.STUDENT, 's3');
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'LAB subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
    const l1 = await lesson(teacher.id, subject.id, 'l1');
    const l2 = await lesson(teacher.id, subject.id, 'l2');
    const l3 = await lesson(teacher.id, subject.id, 'l3');
    const foreign = await lesson(other.id, subject.id, 'foreign');

    // Direct purchases.
    const purchases = ds().getRepository(LessonPurchase);
    const direct: Array<[string, User]> = [
      [l1.id, s1],
      [l1.id, s2],
      [l2.id, s1],
    ];
    for (const [lessonId, student] of direct) {
      const pay = await payment(student.id, ItemType.LESSON, lessonId);
      await purchases.save(
        purchases.create({
          student_id: student.id,
          lesson_id: lessonId,
          payment_id: pay.id,
          price_paid: 100,
          access_granted_at: new Date(),
          access_expires_at: new Date(Date.now() + 86_400_000),
          days_extended: 0,
          revoked_at: null,
          revocation_reason: null,
        }),
      );
    }

    // Packages A and B both contain l1 (bought by the SAME student s3: two purchases);
    // C is soft-deleted, contains l1 and was bought (must not count).
    const packages = ds().getRepository(LessonPackage);
    const mkPackage = async (title: string): Promise<LessonPackage> =>
      packages.save(
        packages.create({
          title,
          title_ar: title,
          description: null,
          description_ar: null,
          teacher_id: teacher.id,
          subject_id: subject.id,
          price: 100,
          original_price: null,
          is_active: true,
        } as never) as unknown as LessonPackage,
      );
    const pa = await mkPackage('pa');
    const pb = await mkPackage('pb');
    const pc = await mkPackage('pc');
    const items = ds().getRepository(LessonPackageItem);
    const itemRows: Array<[LessonPackage, string]> = [
      [pa, l1.id],
      [pa, l2.id],
      [pb, l1.id],
      [pc, l1.id],
    ];
    for (const [pkg, lessonId] of itemRows) {
      await items.save(
        items.create({
          package_id: pkg.id,
          lesson_id: lessonId,
          order_index: 0,
          chapter_id: null,
        } as never),
      );
    }
    const packagePurchases = ds().getRepository(PackagePurchase);
    const bought: Array<[LessonPackage, User]> = [
      [pa, s3],
      [pb, s3],
      [pc, s2],
    ];
    for (const [pkg, student] of bought) {
      const pay = await payment(student.id, ItemType.PACKAGE, pkg.id);
      await packagePurchases.save(
        packagePurchases.create({
          student_id: student.id,
          package_id: pkg.id,
          course_version_id: null,
          payment_id: pay.id,
          price_paid: 100,
          purchased_at: new Date(),
          revoked_at: null,
          revocation_reason: null,
        }),
      );
    }
    await packages.softDelete({ id: pc.id });

    // Sessions: l1 has 4 (2 at >= 90 %), l2 has 1 below 90 %, l3 none.
    const sessions = ds().getRepository(LessonSession);
    const sess = async (lessonId: string, student: User, duration: number, progress: number) =>
      sessions.save(
        sessions.create({
          student_id: student.id,
          lesson_id: lessonId,
          entered_at: new Date(),
          exited_at: null,
          duration_seconds: duration,
          video_progress_percent: progress,
          ip_address: null,
          device_info: null,
        } as never),
      );
    await sess(l1.id, s1, 100, 95);
    await sess(l1.id, s2, 301, 90);
    await sess(l1.id, s3, 50, 10);
    await sess(l1.id, s1, 7, 0);
    await sess(l2.id, s2, 40, 89);

    // Reviews: flagged ones are counted too (all statuses), exactly as the single route does.
    const reviews = ds().getRepository(LessonReview);
    const rev = async (lessonId: string, student: User, rating: number, status: ReviewStatus) =>
      reviews.save(
        reviews.create({
          lesson_id: lessonId,
          student_id: student.id,
          rating,
          comment: null,
          status,
          helpful_count: 0,
          teacher_reply: null,
          teacher_reply_at: null,
        }),
      );
    await rev(l1.id, s1, 5, ReviewStatus.APPROVED);
    await rev(l1.id, s2, 2, ReviewStatus.FLAGGED);
    await rev(l2.id, s1, 4, ReviewStatus.APPROVED);

    // Revenue: paid+completed counts; awaiting / processing-payment orders do not.
    await lessonOrder(teacher.id, s1.id, l1.id, 10_000, OrderStatus.PAID, true);
    await lessonOrder(teacher.id, s2.id, l1.id, 5_050, OrderStatus.PAID, true);
    await lessonOrder(teacher.id, s3.id, l1.id, 9_999, OrderStatus.AWAITING_PAYMENT, true);
    await lessonOrder(teacher.id, s3.id, l1.id, 7_777, OrderStatus.PAID, false);
    await lessonOrder(teacher.id, s1.id, l2.id, 2_500, OrderStatus.PAID, true);

    return { teacher, other, l1, l2, l3, foreign };
  }

  const principal = (u: User) => ({
    userId: u.id,
    email: u.email,
    name: u.name,
    role: u.role as string,
  });

  it('batch[i] deep-equals getLessonAnalytics(id) minus calculated_at, in request order with duplicates', async () => {
    const { teacher, l1, l2, l3 } = await seed();
    const p = principal(teacher);
    const requested = [l2.id, l1.id, l3.id, l1.id];

    const batch = await service.getLessonAnalyticsBatch(p, requested);
    expect(batch).toHaveLength(4);

    const strip = (dto: object) => {
      const { calculated_at: _c, ...rest } = dto as Record<string, unknown>;
      return rest;
    };
    for (const [i, id] of requested.entries()) {
      const single = await service.getLessonAnalytics(p, id);
      expect(strip(batch[i] as object)).toEqual(strip(single));
    }

    // Fixture sanity: the hidden filters really were exercised.
    const one = batch[1] as NonNullable<(typeof batch)[number]>;
    expect(one.total_purchases).toBe(4); // 2 direct + 2 live-package purchases (soft-deleted package excluded)
    expect(one.total_views).toBe(4);
    expect(one.completion_rate).toBe(50);
    expect(one.revenue).toBe(150.5);
    expect(one.total_reviews).toBe(2);
    expect(batch[2]).toMatchObject({
      total_purchases: 0,
      total_views: 0,
      average_rating: null,
      revenue: 0,
    });
  });

  it("fails closed for another teacher's lesson and 404s a missing id", async () => {
    const { teacher, l1, foreign } = await seed();
    await expect(
      service.getLessonAnalyticsBatch(principal(teacher), [l1.id, foreign.id]),
    ).rejects.toThrow('do not have access');
    await expect(
      service.getLessonAnalyticsBatch(principal(teacher), [l1.id, randomUUID()]),
    ).rejects.toThrow('not found');
  });

  it('a cache miss costs at most 6 statements, independent of the number of lessons', async () => {
    const { teacher, l1, l2, l3 } = await seed();
    counter.start();
    await service.getLessonAnalyticsBatch(principal(teacher), [l1.id]);
    const one = counter.stop().length;
    counter.start();
    await service.getLessonAnalyticsBatch(principal(teacher), [l1.id, l2.id, l3.id]);
    const three = counter.stop().length;
    expect(one).toBeLessThanOrEqual(6);
    expect(three).toBe(one);
  });
});
