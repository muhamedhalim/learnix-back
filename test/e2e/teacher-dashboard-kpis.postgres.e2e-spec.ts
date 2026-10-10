import { randomUUID } from 'node:crypto';

import { IsNull, type DataSource } from 'typeorm';

import { AnalyticsService } from '../../src/analytics/analytics.service';
import { LessonSession } from '../../src/attendance/entities/lesson-session.entity';
import { Book } from '../../src/books/entities/book.entity';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import {
  CollectionParty,
  ItemType,
  Order,
  OrderStatus,
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
 * T055 parity: the parallel teacher dashboard must return exactly what the former eight
 * sequential statements returned — except revenue, which T116 moved from gross `paid` to settled net. The reference below is the
 * previous implementation, kept verbatim in this test (repositories + the same
 * QueryBuilder joins), so any predicate drift fails here.
 */
describe('Teacher dashboard KPIs (parity, postgres)', () => {
  let ctx: E2EContext;
  let service: AnalyticsService;
  let counter: StatementCounter;
  let tenantSeq = 0;

  beforeAll(async () => {
    ctx = await createE2EApp();
    service = ctx.app.get(AnalyticsService);
    counter = new StatementCounter(ctx.dataSource);
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;

  /** Previous implementation, verbatim semantics. */
  async function legacy(teacherId: string, from?: Date, to?: Date) {
    const canonical = () =>
      ds()
        .getRepository(Order)
        .createQueryBuilder('order')
        .innerJoin(
          Payment,
          'payment',
          'payment.id = order.payment_id AND payment.status = :completedPaymentStatus',
          { completedPaymentStatus: PaymentStatus.COMPLETED },
        )
        .where('order.status = :paidOrderStatus', { paidOrderStatus: OrderStatus.PAID })
        .andWhere('order.paid_at IS NOT NULL')
        .andWhere('order.teacher_id = :teacherId', { teacherId });

    const totalLessons = await ds()
      .getRepository(Lesson)
      .count({ where: { teacher_id: teacherId, deleted_at: IsNull() } });
    const totalBooks = await ds()
      .getRepository(Book)
      .count({ where: { teacher_id: teacherId, deleted_at: IsNull() } });
    const totalExams = 0; // exams are not seeded in this fixture; the count is a plain scalar

    const students = canonical();
    if (from) students.andWhere('order.paid_at >= :from', { from });
    if (to) students.andWhere('order.paid_at <= :to', { to });
    const paidStudents = await students
      .select('COUNT(DISTINCT order.student_id)', 'count')
      .getRawOne<{ count: string }>();

    const rev = canonical();
    if (from) rev.andWhere('order.paid_at >= :from', { from });
    if (to) rev.andWhere('order.paid_at <= :to', { to });
    const paidRevenue = await rev
      .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total')
      .getRawOne<{ total: string }>();

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const month = canonical().andWhere('order.paid_at >= :start', { start: startOfMonth });
    if (from) month.andWhere('order.paid_at >= :from', { from });
    if (to) month.andWhere('order.paid_at <= :to', { to });
    const monthRevenue = await month
      .select('COALESCE(SUM(order.final_amount_minor), 0) / 100.0', 'total')
      .getRawOne<{ total: string }>();

    const ratingsQuery = ds()
      .getRepository(LessonReview)
      .createQueryBuilder('lr')
      .innerJoin('lr.lesson', 'lesson')
      .where('lesson.teacher_id = :teacherId', { teacherId })
      .andWhere('lr.status = :status', { status: ReviewStatus.APPROVED });
    if (from) ratingsQuery.andWhere('lr.created_at >= :ratingsFrom', { ratingsFrom: from });
    if (to) ratingsQuery.andWhere('lr.created_at <= :ratingsTo', { ratingsTo: to });
    const ratings = await ratingsQuery
      .select('AVG(lr.rating)', 'average')
      .addSelect('COUNT(*)', 'count')
      .getRawOne<{ average: string | null; count: string }>();

    const engagementQuery = ds()
      .getRepository(LessonSession)
      .createQueryBuilder('session')
      .innerJoin('session.lesson', 'engagementLesson')
      .where('engagementLesson.teacher_id = :teacherId', { teacherId });
    if (from) engagementQuery.andWhere('session.entered_at >= :f', { f: from });
    if (to) engagementQuery.andWhere('session.entered_at <= :t', { t: to });

    return {
      totalLessons,
      totalBooks,
      totalExams,
      totalStudents: Number.parseInt(paidStudents?.count ?? '0', 10),
      revenue: Number.parseFloat(paidRevenue?.total ?? '0'),
      revenueThisMonth: Number.parseFloat(monthRevenue?.total ?? '0'),
      averageRating:
        ratings?.average == null ? null : Math.round(Number.parseFloat(ratings.average) * 100) / 100,
      totalReviews: Number.parseInt(ratings?.count ?? '0', 10),
      engagementViews: await engagementQuery.getCount(),
    };
  }

  async function user(role: UserRole, tag: string): Promise<User> {
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `kpi-${tag}`,
        name: `kpi ${tag}`,
        first_name: null,
        last_name: null,
        email: `kpi-${tag}@example.test`,
        phone: `0114${Math.floor(1_000_000 + Math.random() * 8_999_999).toString()}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
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

  async function order(
    teacherId: string,
    studentId: string,
    ref: string,
    paidAt: Date,
    options: {
      status?: OrderStatus;
      paymentStatus?: PaymentStatus;
      amountMinor?: number;
      refundedMinor?: number;
    } = {},
  ): Promise<void> {
    const amount = options.amountMinor ?? 10_000;
    const orders = ds().getRepository(Order);
    const payments = ds().getRepository(Payment);
    const saved = await orders.save(
      orders.create({
        order_number: `KPI-${ref}`,
        student_id: studentId,
        teacher_id: teacherId,
        item_type: ItemType.LESSON,
        item_id: randomUUID(),
        quantity: 1,
        original_amount_minor: amount,
        discount_amount_minor: 0,
        final_amount_minor: amount,
        refunded_amount_minor: options.refundedMinor ?? 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: null,
        status: options.status ?? OrderStatus.PAID,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        cart_checkout_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'KPI lesson',
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
        paid_at: options.status === OrderStatus.AWAITING_PAYMENT ? null : paidAt,
        cancelled_at: null,
      }),
    );
    const payment = await payments.save(
      payments.create({
        order_id: saved.id,
        user_id: studentId,
        item_type: ItemType.LESSON,
        item_id: saved.item_id,
        amount: amount / 100,
        discount_amount: 0,
        final_amount: amount / 100,
        amount_minor: amount,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: null,
        provider_reference: `kpi-${ref}`,
        status: options.paymentStatus ?? PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.CARD,
        paymob_order_id: null,
        paymob_transaction_id: null,
        idempotency_key: `kpi-${ref}`,
        failure_reason: null,
        completed_at: null,
      }),
    );
    await orders.update({ id: saved.id }, { payment_id: payment.id });
  }

  async function seed() {
    const teacher = await user(UserRole.TEACHER, 't1');
    const other = await user(UserRole.TEACHER, 't2');
    const s1 = await user(UserRole.STUDENT, 's1');
    const s2 = await user(UserRole.STUDENT, 's2');
    const s3 = await user(UserRole.STUDENT, 's3');
    const subjects = ds().getRepository(Subject);
    const subject = await subjects.save(
      subjects.create({
        name: 'KPI subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );

    const live = await lesson(teacher.id, subject.id, 'live');
    const gone = await lesson(teacher.id, subject.id, 'soft-deleted');
    const foreign = await lesson(other.id, subject.id, 'foreign');
    await ds().getRepository(Lesson).softDelete({ id: gone.id });

    await ds().getRepository(Book).save(
      ds().getRepository(Book).create({
        title: 'KPI book',
        title_ar: 'كتاب',
        description: null,
        description_ar: null,
        teacher_id: teacher.id,
        subject_id: subject.id,
        cover_image: null,
        book_file: 'k/book.pdf',
        price: 10,
      } as never),
    );

    const reviews = ds().getRepository(LessonReview);
    const review = (l: Lesson, st: User, rating: number, status: ReviewStatus, at: Date) =>
      reviews.save(
        reviews.create({
          lesson_id: l.id,
          student_id: st.id,
          rating,
          comment: null,
          status,
          helpful_count: 0,
          teacher_reply: null,
          teacher_reply_at: null,
          created_at: at,
        }),
      );
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
    await review(live, s1, 5, ReviewStatus.APPROVED, now);
    await review(live, s2, 3, ReviewStatus.APPROVED, lastMonth);
    await review(live, s3, 1, ReviewStatus.FLAGGED, now); // not approved: excluded
    await review(gone, s1, 1, ReviewStatus.APPROVED, now); // soft-deleted lesson: excluded
    await review(foreign, s1, 2, ReviewStatus.APPROVED, now); // other teacher: excluded

    const sessions = ds().getRepository(LessonSession);
    const sess = (l: Lesson, st: User, at: Date) =>
      sessions.save(
        sessions.create({
          student_id: st.id,
          lesson_id: l.id,
          entered_at: at,
          exited_at: null,
          duration_seconds: 0,
          video_progress_percent: 0,
          ip_address: null,
          device_info: null,
        } as never),
      );
    await sess(live, s1, now);
    await sess(live, s2, now);
    await sess(live, s2, lastMonth);
    await sess(gone, s1, now); // soft-deleted lesson: excluded
    await sess(foreign, s1, now); // other teacher: excluded

    await order(teacher.id, s1.id, 'a', now);
    await order(teacher.id, s1.id, 'b', now, { amountMinor: 5_050 }); // same student twice
    await order(teacher.id, s2.id, 'c', lastMonth, { amountMinor: 20_000 });
    await order(teacher.id, s3.id, 'd', now, { refundedMinor: 3_000 }); // refunded but still paid
    await order(other.id, s1.id, 'e', now); // another teacher's order
    await order(teacher.id, s2.id, 'f', now, { status: OrderStatus.AWAITING_PAYMENT });
    await order(teacher.id, s3.id, 'g', now, { paymentStatus: PaymentStatus.PROCESSING });
    return { teacher, other, now, lastMonth };
  }

  /**
   * T116 (W7-C4): the one documented value change. Revenue is the settled net
   * (charged minus refunded) per currency, computed here from raw SQL with the
   * statuses spelled out so it cannot drift together with the implementation.
   */
  async function settledRevenue(teacherId: string, from?: Date, to?: Date) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const params: unknown[] = [teacherId, startOfMonth];
    let range = '';
    if (from) {
      params.push(from);
      range += ` AND o.paid_at >= $${String(params.length)}`;
    }
    if (to) {
      params.push(to);
      range += ` AND o.paid_at <= $${String(params.length)}`;
    }
    const rows = await ds().query<Array<{ currency: string; total: string; month: string }>>(
      `SELECT o.currency,
              (COALESCE(SUM(o.final_amount_minor - o.refunded_amount_minor), 0))::text AS total,
              (COALESCE(SUM(o.final_amount_minor - o.refunded_amount_minor)
                        FILTER (WHERE o.paid_at >= $2), 0))::text AS month
         FROM orders o
         JOIN payments p ON p.id = o.payment_id
        WHERE o.teacher_id = $1
          AND o.paid_at IS NOT NULL
          AND o.status IN ('paid', 'partially_refunded', 'refunded')
          AND p.status IN ('completed', 'refunded')${range}
        GROUP BY o.currency
        ORDER BY SUM(o.final_amount_minor - o.refunded_amount_minor) DESC, o.currency ASC`,
      params,
    );
    const revenueByCurrency = rows.map((r) => ({
      currency: r.currency,
      amount: Number(r.total) / 100,
      amountThisMonth: Number(r.month) / 100,
    }));
    return {
      revenue: revenueByCurrency[0]?.amount ?? 0,
      revenueThisMonth: revenueByCurrency[0]?.amountThisMonth ?? 0,
      revenueByCurrency,
    };
  }

  /** The previous implementation's output with only the revenue fields redefined (T116). */
  async function expectedDashboard(teacherId: string, from?: Date, to?: Date) {
    return { ...(await legacy(teacherId, from, to)), ...(await settledRevenue(teacherId, from, to)) };
  }

  async function fresh(teacherId: string, from?: Date, to?: Date) {
    // A unique tenant gives a unique cache key, so every call is a cache miss.
    tenantSeq += 1;
    return service.getTeacherDashboard(teacherId, `kpi-parity-${String(tenantSeq)}`, from, to);
  }

  it('equals the previous implementation: no range', async () => {
    const { teacher } = await seed();
    const expected = await expectedDashboard(teacher.id);
    const actual = await fresh(teacher.id);
    expect(actual).toEqual(expected);
    // The seeded "refunded but still paid" order (30.00 refunded) is now netted out of revenue,
    // while every non-revenue field is exactly what the previous implementation returned.
    const old = await legacy(teacher.id);
    expect(actual.revenue).toBe(old.revenue - 30);
    expect(actual.revenueThisMonth).toBe(old.revenueThisMonth - 30);
    expect(actual.revenueByCurrency).toEqual([
      { currency: 'EGP', amount: actual.revenue, amountThisMonth: actual.revenueThisMonth },
    ]);
    expect(actual.totalStudents).toBe(old.totalStudents);
    // Sanity: the fixture exercised every family (not an all-zero comparison).
    expect(actual.totalLessons).toBe(1);
    expect(actual.totalBooks).toBe(1);
    expect(actual.totalStudents).toBe(3);
    expect(actual.totalReviews).toBe(2);
    expect(actual.engagementViews).toBe(3);
    expect(actual.revenue).toBeGreaterThan(0);
  });

  it('equals the previous implementation: range crossing the month start', async () => {
    const { teacher, now, lastMonth } = await seed();
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getTime() + 60_000);
    expect(await fresh(teacher.id, from, to)).toEqual(await expectedDashboard(teacher.id, from, to));
    const narrow = new Date(lastMonth.getTime() + 24 * 3_600_000);
    expect(await fresh(teacher.id, narrow, to)).toEqual(
      await expectedDashboard(teacher.id, narrow, to),
    );
    expect(await fresh(teacher.id, undefined, narrow)).toEqual(
      await expectedDashboard(teacher.id, undefined, narrow),
    );
  });

  it('a teacher with no data gets the zero/null shape', async () => {
    const empty = await user(UserRole.TEACHER, 'empty');
    expect(await fresh(empty.id)).toEqual(await expectedDashboard(empty.id));
  });

  it('a cache miss costs exactly four statements (content, buyers, settled revenue, engagement)', async () => {
    const { teacher } = await seed();
    counter.start();
    await fresh(teacher.id);
    counter.stop();
    expect(counter.count({})).toBe(4);
  });
});
