import { randomUUID } from 'node:crypto';

import request from 'supertest';
import type { DataSource } from 'typeorm';

import { ApplicationCacheService } from '../../src/common/cache/application-cache.service';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { LessonPackage } from '../../src/packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../../src/packages/entities/lesson-package-item.entity';
import { TeacherReview } from '../../src/reviews/entities/teacher-review.entity';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { TeacherProfile } from '../../src/teachers/entities/teacher-profile.entity';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { StatementCounter } from './helpers/statement-counter';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type E2EContext,
} from './fixtures';

jest.setTimeout(180_000);

/**
 * T084 / T085 (W5-C10): sorting package lists by live lesson count and teacher lists by rating.
 * Both sort keys are raw SQL expressions; with `skip/take` over to-many joins TypeORM's paged-ids
 * path has to resolve them to selected aliases, which is the suspected 500. Every case asserts the
 * CORRECT behaviour (200, correct order, full pages, stable pagination), so this file fails first on a
 * defective implementation and is the regression suite once T085 lands. Observed statuses are
 * recorded in specs/004-api-db-efficiency-audit/gates/W5-C10.md.
 */
describe('Listing sorts on raw expressions (postgres)', () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await createE2EApp();
  });
  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    // The public catalog responses are cached by query shape; each case seeds different rows.
    await ctx.app.get(ApplicationCacheService).invalidateAll();
  });
  afterAll(async () => ctx.app.close());

  const ds = (): DataSource => ctx.dataSource;
  let seq = 0;

  async function subject(): Promise<Subject> {
    const repo = ds().getRepository(Subject);
    return repo.save(
      repo.create({
        name: `LS subject ${String((seq += 1))}`,
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

  async function teacherUser(tag: string): Promise<User> {
    seq += 1;
    const users = ds().getRepository(User);
    return users.save(
      users.create({
        username: `ls-${tag}-${String(seq)}`,
        name: `LS Teacher ${tag}`,
        first_name: `First${tag}`,
        last_name: `Last${tag}`,
        email: `ls-${tag}-${String(seq)}@example.test`,
        phone: `0129${String(seq).padStart(7, '0')}`,
        role: UserRole.TEACHER,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function profile(user: User, subjects: Subject[]): Promise<TeacherProfile> {
    const repo = ds().getRepository(TeacherProfile);
    return repo.save(
      repo.create({
        user_id: user.id,
        qualifications: 'MSc',
        years_of_experience: 5,
        bio: null,
        subjects,
      } as never) as unknown as TeacherProfile,
    );
  }

  async function review(teacherId: string, studentId: string, rating: number): Promise<void> {
    const repo = ds().getRepository(TeacherReview);
    await repo.save(
      repo.create({
        teacher_id: teacherId,
        student_id: studentId,
        rating,
        comment: null,
      } as never),
    );
  }

  async function packageWith(
    teacher: User,
    s: Subject,
    title: string,
    liveLessons: number,
    deletedLessons = 0,
  ): Promise<LessonPackage> {
    const lessonRepo = ds().getRepository(Lesson);
    const lessons: Lesson[] = [];
    for (let i = 0; i < liveLessons + deletedLessons; i += 1) {
      const lesson = await lessonRepo.save(
        lessonRepo.create({
          title: `${title} lesson ${String(i)}`,
          description: null,
          teacher_id: teacher.id,
          subject_id: s.id,
          thumbnail: null,
          price: 0,
          duration: 600,
          is_group: true,
          available_for_days: 30,
          students_count: 0,
          is_free_preview: false,
        }),
      );
      if (i >= liveLessons) await lessonRepo.softDelete({ id: lesson.id });
      lessons.push(lesson);
    }
    const packages = ds().getRepository(LessonPackage);
    const saved = await packages.save(
      packages.create({
        title,
        title_ar: title,
        description: null,
        description_ar: null,
        teacher_id: teacher.id,
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
    return saved;
  }

  async function seedPackages() {
    const s = await subject();
    const teacher = await teacherUser('pkg');
    await profile(teacher, [s]);
    // Live lesson counts: big 5, mid 3 (a 4th item points at a soft-deleted lesson), small 1.
    const big = await packageWith(teacher, s, 'Big', 5);
    const mid = await packageWith(teacher, s, 'Mid', 3, 1);
    const small = await packageWith(teacher, s, 'Small', 1);
    return { s, teacher, big, mid, small };
  }

  const ids = (body: { data: Array<{ id: string }> }): string[] => body.data.map((row) => row.id);

  describe('packages: sortBy=lessons_count', () => {
    it('GET /packages orders by live lesson count both ways and pages without under-fill', async () => {
      const { big, mid, small } = await seedPackages();
      const server = ctx.app.getHttpServer();

      const desc = await request(server)
        .get(`${API_PREFIX}/packages`)
        .query({ sortBy: 'lessons_count', order: 'desc' });
      expect(desc.status).toBe(200);
      expect(ids(desc.body)).toEqual([big.id, mid.id, small.id]);
      expect(desc.body.data.map((row: { lessons_count: number }) => row.lessons_count)).toEqual([
        5, 3, 1,
      ]);

      const asc = await request(server)
        .get(`${API_PREFIX}/packages`)
        .query({ sortBy: 'lessons_count', order: 'asc' });
      expect(asc.status).toBe(200);
      expect(ids(asc.body)).toEqual([small.id, mid.id, big.id]);

      // A package with more items than `limit`: every non-final page still has exactly `limit` rows.
      const page1 = await request(server)
        .get(`${API_PREFIX}/packages`)
        .query({ sortBy: 'lessons_count', order: 'desc', limit: 2, page: 1 });
      const page2 = await request(server)
        .get(`${API_PREFIX}/packages`)
        .query({ sortBy: 'lessons_count', order: 'desc', limit: 2, page: 2 });
      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page2.body.data).toHaveLength(1);
      expect([...ids(page1.body), ...ids(page2.body)]).toEqual([big.id, mid.id, small.id]);
      expect(page1.body.meta.total).toBe(3);
    });

    it('GET /admin/packages accepts the same sort', async () => {
      const { big, mid, small } = await seedPackages();
      const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });

      const adminList = await admin.agent
        .get(`${API_PREFIX}/admin/packages`)
        .query({ sortBy: 'lessons_count', order: 'desc' });
      expect(adminList.status).toBe(200);
      expect(ids(adminList.body)).toEqual([big.id, mid.id, small.id]);
    });

    it('GET /teacher/packages accepts the same sort for the owning teacher', async () => {
      const { teacher, big, mid, small } = await seedPackages();
      const owner = await createAuthenticatedUser(ctx.app, ds(), { role: 'teacher' });
      await ds()
        .getRepository(LessonPackage)
        .update({ teacher_id: teacher.id }, { teacher_id: owner.userId });
      const mine = await owner.agent
        .get(`${API_PREFIX}/teacher/packages`)
        .query({ sortBy: 'lessons_count', order: 'asc' });
      expect(mine.status).toBe(200);
      expect(ids(mine.body)).toEqual([small.id, mid.id, big.id]);
    });

    it('keeps the other sort keys working (price, created_at)', async () => {
      await seedPackages();
      const server = ctx.app.getHttpServer();
      for (const sortBy of ['price', 'created_at', 'title']) {
        const res = await request(server).get(`${API_PREFIX}/packages`).query({ sortBy });
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(3);
      }
    });
  });

  describe('page boundaries and statement shape (T085)', () => {
    it('packages: multi-item packages straddling page edges never duplicate, drop or under-fill a page', async () => {
      const s = await subject();
      const teacher = await teacherUser('boundary');
      await profile(teacher, [s]);
      // Item counts 6,5,5,4,3,1 with limit 2: the biggest packages sit on every page edge.
      const made: LessonPackage[] = [];
      for (const [index, count] of [6, 5, 5, 4, 3, 1].entries()) {
        made.push(await packageWith(teacher, s, `Edge ${String(index)}`, count));
      }
      const server = ctx.app.getHttpServer();

      for (const sortBy of ['lessons_count', 'price', 'created_at']) {
        for (const order of ['asc', 'desc']) {
          const seen: string[] = [];
          for (const page of [1, 2, 3]) {
            const res = await request(server)
              .get(`${API_PREFIX}/packages`)
              .query({ sortBy, order, limit: 2, page });
            expect(res.status).toBe(200);
            expect(res.body.data).toHaveLength(2);
            expect(res.body.meta.total).toBe(6);
            seen.push(...ids(res.body));
          }
          expect(new Set(seen).size).toBe(6);
          expect([...seen].sort()).toEqual(made.map((pkg) => pkg.id).sort());
        }
      }
    });

    it('packages (T087): no statement hydrates items or lessons; the list carries lessons_count instead of lessons[]', async () => {
      const { teacher } = await seedPackages();
      expect(teacher).toBeDefined();
      const counter = new StatementCounter(ds());
      counter.start();
      const res = await request(ctx.app.getHttpServer())
        .get(`${API_PREFIX}/packages`)
        .query({ sortBy: 'lessons_count', order: 'desc', limit: 2 })
        .set('X-Request-Id', 'ls-package-shape');
      counter.stop();
      expect(res.status).toBe(200);

      const sql = counter
        .statements()
        .filter((statement) => statement.requestId === 'ls-package-shape')
        .map((statement) => statement.sql);
      const joinsItems = (text: string): boolean =>
        /JOIN "lesson_package_items" "items"/.test(text);
      const hydrate = sql.filter((text) => /=\s*ANY\s*\(/.test(text));
      expect(hydrate.length).toBe(1);
      // Neither the count, the ids page, nor the hydrate step joins the items: only a scalar subquery counts them.
      expect(sql.filter((text) => joinsItems(text))).toEqual([]);
      for (const row of res.body.data as Array<Record<string, unknown>>) {
        expect(row).not.toHaveProperty('lessons');
        expect(typeof row['lessons_count']).toBe('number');
      }
      expect(res.body.data.map((row: { lessons_count: number }) => row.lessons_count)).toEqual([
        5, 3,
      ]);
    });
  });

  describe('teachers: sortBy=rating', () => {
    async function seedTeachers() {
      const s1 = await subject();
      const s2 = await subject();
      const s3 = await subject();
      // Several subjects each: the to-many join that multiplies rows in a paged query.
      const top = await teacherUser('top');
      const mid = await teacherUser('mid');
      const none = await teacherUser('none');
      await profile(top, [s1, s2, s3]);
      await profile(mid, [s1, s2]);
      await profile(none, [s1, s2, s3]);
      const students = [await teacherUser('s1'), await teacherUser('s2')];
      await review(top.id, students[0]!.id, 5);
      await review(top.id, students[1]!.id, 5);
      await review(mid.id, students[0]!.id, 3);
      await review(mid.id, students[1]!.id, 2);
      return { top, mid, none };
    }

    const userIds = (body: {
      data: Array<{ user_id?: string; user?: { id: string } }>;
    }): string[] => body.data.map((row) => row.user_id ?? row.user!.id);

    it('GET /teachers?sortBy=rating lists unrated teachers last in descending order, with full pages', async () => {
      const { top, mid, none } = await seedTeachers();
      const server = ctx.app.getHttpServer();

      const res = await request(server)
        .get(`${API_PREFIX}/teachers`)
        .query({ sortBy: 'rating', order: 'desc' });
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(3);
      const names = (res.body.data as Array<{ name: string }>).map((row) => row.name);
      expect(names).toEqual([top.name, mid.name, none.name]);

      const page1 = await request(server)
        .get(`${API_PREFIX}/teachers`)
        .query({ sortBy: 'rating', order: 'desc', limit: 2, page: 1 });
      const page2 = await request(server)
        .get(`${API_PREFIX}/teachers`)
        .query({ sortBy: 'rating', order: 'desc', limit: 2, page: 2 });
      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      expect(page1.body.data).toHaveLength(2);
      expect(page2.body.data).toHaveLength(1);
      expect(page1.body.meta.total).toBe(3);
    });

    it('multi-subject teachers straddling page edges: no duplicate or missing ids, full pages, distinct total (public and admin)', async () => {
      const subjects = [await subject(), await subject(), await subject()];
      const reviewer = await teacherUser('reviewer');
      const made: User[] = [];
      for (let i = 0; i < 5; i += 1) {
        const t = await teacherUser(`edge${String(i)}`);
        await profile(t, subjects);
        await review(t.id, reviewer.id, (i % 5) + 1);
        made.push(t);
      }
      const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
      const server = ctx.app.getHttpServer();

      for (const sortBy of ['rating', 'name', 'created_at']) {
        const publicSeen: string[] = [];
        const adminSeen: string[] = [];
        for (const page of [1, 2, 3]) {
          const pub = await request(server)
            .get(`${API_PREFIX}/teachers`)
            .query({ sortBy, order: 'desc', limit: 2, page });
          expect(pub.status).toBe(200);
          expect(pub.body.data).toHaveLength(page < 3 ? 2 : 1);
          expect(pub.body.meta.total).toBe(5);
          publicSeen.push(...(pub.body.data as Array<{ id: string }>).map((row) => row.id));
          // Subjects are still hydrated for the page's rows.
          for (const row of pub.body.data as Array<{ subjects?: unknown[] }>) {
            expect(row.subjects ?? []).toHaveLength(3);
          }

          const adm = await admin.agent
            .get(`${API_PREFIX}/admin/teachers`)
            .query({ sortBy, order: 'desc', limit: 2, page, status: 'approved' });
          expect(adm.status).toBe(200);
          expect(adm.body.meta.total).toBe(5); // the reviewer has no teacher profile
          adminSeen.push(...(adm.body.data as Array<{ id: string }>).map((row) => row.id));
        }
        expect(new Set(publicSeen).size).toBe(5);
        expect(new Set(adminSeen).size).toBe(adminSeen.length);
      }
      expect(made).toHaveLength(5);
    });

    it('the teacher count and ids statements do not join the many-to-many subjects relation', async () => {
      await seedTeachers();
      const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });
      const counter = new StatementCounter(ds());
      counter.start();
      const res = await admin.agent
        .get(`${API_PREFIX}/admin/teachers`)
        .query({ sortBy: 'rating', order: 'desc', limit: 2 })
        .set('X-Request-Id', 'ls-teacher-shape');
      counter.stop();
      expect(res.status).toBe(200);
      const sql = counter
        .statements()
        .filter((statement) => statement.requestId === 'ls-teacher-shape')
        .map((statement) => statement.sql)
        .filter((text) => text.includes('"teacher_profiles"'));
      const joinsSubjects = (text: string): boolean => /JOIN "teacher_subjects"/.test(text);
      const hydrate = sql.filter((text) => /=\s*ANY\s*\(/.test(text));
      expect(hydrate).toHaveLength(1);
      expect(joinsSubjects(hydrate[0]!)).toBe(true);
      expect(sql.filter((text) => joinsSubjects(text) && !/=\s*ANY\s*\(/.test(text))).toEqual([]);
    });

    it('GET /admin/teachers?sortBy=rating sorts, counts distinct teachers and pages stably', async () => {
      const { top, mid, none } = await seedTeachers();
      const admin = await createAuthenticatedUser(ctx.app, ds(), { role: 'admin' });

      const page1 = await admin.agent
        .get(`${API_PREFIX}/admin/teachers`)
        .query({ sortBy: 'rating', order: 'desc', limit: 2, page: 1 });
      const page2 = await admin.agent
        .get(`${API_PREFIX}/admin/teachers`)
        .query({ sortBy: 'rating', order: 'desc', limit: 2, page: 2 });
      expect(page1.status).toBe(200);
      expect(page2.status).toBe(200);
      expect(page1.body.meta.total).toBeGreaterThanOrEqual(3);
      const seen = [...userIds(page1.body), ...userIds(page2.body)];
      expect(new Set(seen).size).toBe(seen.length);
      // The three seeded teachers appear in rating order relative to each other.
      const order = seen.filter((id) => [top.id, mid.id, none.id].includes(id));
      expect(order).toEqual([top.id, mid.id, none.id]);
      expect(randomUUID()).toBeTruthy();
    });
  });
});
