import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import {
  ItemType,
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
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

jest.setTimeout(180_000);

/**
 * T082 (W5-C12): `GET /payments/my-packages` selects only the relation columns the study screens
 * read. The real query runs on Postgres, which proves no unknown select key slipped in (TypeORM
 * throws on one). T117 later extends this file.
 */
describe('Student my-packages (postgres)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => resetDatabase(ctx.dataSource));
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  let seq = 0;

  async function teacher(): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `smp-teacher-${String(seq)}`,
        name: `Smp Teacher ${String(seq)}`,
        first_name: null,
        last_name: null,
        email: `smp-teacher-${String(seq)}@example.test`,
        phone: `0125${String(seq).padStart(7, '0')}`,
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function subject(): Promise<Subject> {
    const repo = ds().getRepository(Subject);
    return repo.save(
      repo.create({
        name: 'SMP subject',
        description: null,
        description_ar: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
  }

  async function pkg(
    t: User,
    s: Subject,
    title: string,
    lessonTitles: string[],
  ): Promise<{ pkg: LessonPackage; lessons: Lesson[] }> {
    const lessonRepo = ds().getRepository(Lesson);
    const lessons: Lesson[] = [];
    for (const lessonTitle of lessonTitles) {
      lessons.push(
        await lessonRepo.save(
          lessonRepo.create({
            title: lessonTitle,
            description: 'long description that must not be selected',
            teacher_id: t.id,
            subject_id: s.id,
            thumbnail: null,
            price: 0,
            duration: 600,
            is_group: true,
            available_for_days: 30,
            students_count: 0,
            is_free_preview: false,
          }),
        ),
      );
    }
    const packages = ds().getRepository(LessonPackage);
    const saved = await packages.save(
      packages.create({
        title,
        title_ar: `${title} ar`,
        description: null,
        description_ar: null,
        teacher_id: t.id,
        subject_id: s.id,
        price: 100,
        original_price: null,
        is_active: true,
        thumbnail: null,
        status: CourseStatus.PUBLISHED,
        published_at: new Date(),
      }),
    );
    const items = ds().getRepository(LessonPackageItem);
    await items.save(
      lessons.map((lesson, index) =>
        items.create({ package_id: saved.id, lesson_id: lesson.id, order_index: index }),
      ),
    );
    return { pkg: saved, lessons };
  }

  async function buy(studentId: string, packageId: string, revoked = false): Promise<void> {
    seq += 1;
    const payments = ds().getRepository(Payment);
    const pay = await payments.save(
      payments.create({
        order_id: null,
        user_id: studentId,
        item_type: ItemType.PACKAGE,
        item_id: packageId,
        amount: 100,
        discount_amount: 0,
        final_amount: 100,
        amount_minor: 10_000,
        currency: 'EGP',
        channel: PaymentChannel.MANUAL,
        provider: null,
        provider_reference: `smp-${String(seq)}`,
        status: PaymentStatus.COMPLETED,
        payment_method: PaymentMethod.MANUAL,
        paymob_order_id: null,
        paymob_transaction_id: null,
        idempotency_key: `smp-${String(seq)}-${randomUUID()}`,
        failure_reason: null,
        completed_at: new Date(),
      }),
    );
    const purchases = ds().getRepository(PackagePurchase);
    await purchases.save(
      purchases.create({
        student_id: studentId,
        package_id: packageId,
        payment_id: pay.id,
        price_paid: 100,
        purchased_at: new Date(Date.now() - seq * 1000),
        revoked_at: revoked ? new Date() : null,
        revocation_reason: revoked ? 'refund' : null,
      }),
    );
  }

  it('returns what the study screens read, narrows the teacher and lesson columns, excludes revoked purchases', async () => {
    const t = await teacher();
    const s = await subject();
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const a = await pkg(t, s, 'Algebra', ['Intro', 'Equations']);
    const b = await pkg(t, s, 'Geometry', ['Angles']);
    await buy(student.userId, a.pkg.id);
    await buy(student.userId, b.pkg.id, true);

    const res = await student.agent.get(`${API_PREFIX}/payments/my-packages`).expect(200);

    expect(res.body.meta).toMatchObject({ total: 1, page: 1, limit: 20 });
    const [purchase] = res.body.data as Array<Record<string, any>>;
    // Fields `useStudentLearning` / the study page read.
    expect(purchase).toMatchObject({ package_id: a.pkg.id });
    expect(purchase['id']).toEqual(expect.any(String));
    expect(purchase['purchased_at']).toEqual(expect.any(String));
    expect(purchase['package']).toMatchObject({
      id: a.pkg.id,
      title: 'Algebra',
      title_ar: 'Algebra ar',
    });
    expect(purchase['package'].teacher).toEqual({
      id: t.id,
      name: t.name,
      profile_picture_url: null,
    });
    const items = (purchase['package'].items as Array<Record<string, any>>).sort(
      (x, y) => x['order_index'] - y['order_index'],
    );
    expect(items.map((item) => item['lesson'].title)).toEqual(['Intro', 'Equations']);
    for (const item of items) {
      expect(item['lesson_id']).toEqual(item['lesson'].id);
      expect(Object.keys(item['lesson']).sort()).toEqual(['duration', 'id', 'title']);
    }
    // Account data of the teacher is no longer exposed.
    expect(purchase['package'].teacher).not.toHaveProperty('email');
    expect(purchase['package'].teacher).not.toHaveProperty('phone');
  });

  it('returns every live course exactly once: repurchases collapse, revoked excluded, paging counts courses', async () => {
    const t = await teacher();
    const s = await subject();
    const student = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const created: Array<{ pkg: LessonPackage }> = [];
    for (let i = 0; i < 25; i += 1) {
      const c = await pkg(t, s, `Course ${String(i)}`, ['First', 'Second']);
      created.push(c);
      await buy(student.userId, c.pkg.id);
    }
    // two repurchases of one course and one revoked-only course
    await buy(student.userId, created[0]!.pkg.id);
    await buy(student.userId, created[0]!.pkg.id);
    const revokedOnly = await pkg(t, s, 'Revoked only', ['X']);
    await buy(student.userId, revokedOnly.pkg.id, true);

    const all = await student.agent
      .get(`${API_PREFIX}/payments/my-packages`)
      .query({ limit: 100 })
      .expect(200);
    const rows = all.body.data as Array<Record<string, any>>;
    expect(all.body.meta).toMatchObject({ total: 25, limit: 100, totalPages: 1 });
    expect(rows).toHaveLength(25);
    const packageIds = rows.map((r) => r['package_id'] as string);
    expect(new Set(packageIds).size).toBe(25);
    expect(packageIds).not.toContain(revokedOnly.pkg.id);
    // items ordered by order_index, lesson projection unchanged
    for (const row of rows) {
      const items = row['package'].items as Array<Record<string, any>>;
      expect(items.map((i) => i['order_index'])).toEqual([0, 1]);
      expect(Object.keys(items[0]!['lesson']).sort()).toEqual(['duration', 'id', 'title']);
    }

    const first = await student.agent
      .get(`${API_PREFIX}/payments/my-packages`)
      .query({ page: 1, limit: 20 })
      .expect(200);
    expect(first.body.data).toHaveLength(20);
    expect(first.body.meta).toMatchObject({ total: 25, limit: 20, totalPages: 2, hasNextPage: true });
    const second = await student.agent
      .get(`${API_PREFIX}/payments/my-packages`)
      .query({ page: 2, limit: 20 })
      .expect(200);
    expect(second.body.data).toHaveLength(5);
    const paged = [...first.body.data, ...second.body.data].map((r: any) => r.package_id);
    expect(new Set(paged).size).toBe(25);
  });

  it("never returns another student's purchases", async () => {
    const t = await teacher();
    const s = await subject();
    const mine = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const other = await createAuthenticatedUser(ctx.app, ds(), { role: 'student' });
    const created = await pkg(t, s, 'Private', ['L']);
    await buy(other.userId, created.pkg.id);

    const res = await mine.agent.get(`${API_PREFIX}/payments/my-packages`).expect(200);
    expect(res.body.data).toHaveLength(0);
  });
});
