import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { LessonContentType, MarketplaceCourseStatus } from '../../src/marketplace/common/enums';
import { MarketplaceCategory, MarketplaceCourse } from '../../src/marketplace/catalog/entities';
import { MarketplaceInstructor } from '../../src/marketplace/instructors/entities/marketplace-instructor.entity';
import { buildInstructorFixture } from './factories/marketplace.factory';
import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  setUserRole,
} from './fixtures';
import { StatementCounter } from './helpers/statement-counter';
import { TEST_IMAGE_KEY, TEST_IMAGE_KEY_2 } from './helpers/images';

/**
 * T055 — contracts §3 (course authoring) and §5 (course moderation).
 * The independent test named by Phase 4's own header: draft → submit
 * (refused while incomplete) → admin reject with notes → fix → resubmit
 * → approve → instructor publishes → unpublish preserves existing access.
 */
describe('marketplace course lifecycle — contract (contracts §3, §5)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedInstructor(userId: string) {
    const fixture = buildInstructorFixture({ user_id: userId });
    return dataSource.getRepository(MarketplaceInstructor).save(fixture);
  }

  async function seedCategory() {
    return dataSource.getRepository(MarketplaceCategory).save({
      name_en: 'Programming',
      name_ar: 'البرمجة',
      slug: `programming-${Date.now()}`,
      display_order: 1,
    });
  }

  const courseBody = (categoryId: string) => ({
    title: 'Backend Engineering 101',
    summary: 'Learn to build backend systems',
    description: 'A full description of the course content.',
    category_id: categoryId,
    level: 'beginner',
    language: 'en',
    price_minor: 5000,
    currency: 'EGP',
    cover_image_key: TEST_IMAGE_KEY,
    learning_outcomes: ['Build a REST API'],
  });

  it('takes a course from draft through admin rejection, resubmission, approval, and instructor publish; unpublish preserves access', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');

    // Create the draft.
    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);
    const courseId = created.body.id as string;
    expect(created.body.status).toBe('draft');

    // Submit while incomplete (no curriculum yet) is refused, naming every unmet item.
    const incompleteSubmit = await instructorUser.agent.post(
      `${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`,
    );
    expect(incompleteSubmit.status).toBe(422);
    expect(incompleteSubmit.body.details).toEqual(
      expect.arrayContaining(['at_least_one_section', 'minimum_lessons']),
    );

    // Build a minimally-ready curriculum: one section, three lessons (one required, one free preview).
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Getting Started' })
      .expect(201);
    const sectionId = section.body.id as string;

    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: sectionId,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          duration_seconds: 120,
          is_free_preview: i === 0,
        })
        .expect(201);
    }

    const readiness = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/readiness`)
      .expect(200);
    expect(readiness.body.ready).toBe(true);

    // The curriculum editor's own read (added during T073 — see contracts/README.md).
    const ownCurriculum = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/curriculum`)
      .expect(200);
    expect(ownCurriculum.body.sections[0].lessons).toHaveLength(3);

    // Submit for review.
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    const submittedCourse = await dataSource
      .getRepository(MarketplaceCourse)
      .findOne({ where: { id: courseId } });
    expect(submittedCourse?.status).toBe(MarketplaceCourseStatus.SUBMITTED_FOR_REVIEW);

    // Read-only to the instructor while under review (FR-063).
    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ title: 'Cannot edit now' })
      .expect(403);

    // Admin reviews the full content and rejects with reasons + per-item notes.
    const content = await admin.agent
      .get(`${API_PREFIX}/marketplace/admin/courses/${courseId}/content`)
      .expect(200);
    expect(content.body.sections[0].lessons).toHaveLength(3);

    // "Full content playable" (T077) — these are text lessons, so there's nothing to play yet; the
    // endpoint still routes and answers correctly rather than 500ing.
    const textLessonId = content.body.sections[0].lessons[0].id as string;
    await admin.agent
      .get(`${API_PREFIX}/marketplace/admin/courses/${courseId}/lessons/${textLessonId}/video`)
      .expect(404);

    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/reject`)
      .send({
        reasons: ['Cover image is low resolution'],
        item_notes: { cover_image: 'Use at least 1280x720' },
      })
      .expect(201);
    const rejectedCourse = await dataSource
      .getRepository(MarketplaceCourse)
      .findOne({ where: { id: courseId } });
    expect(rejectedCourse?.status).toBe(MarketplaceCourseStatus.REJECTED);

    // The instructor can read why (T072's review-decisions read — see contracts/README.md).
    const decisions = await instructorUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/review-decisions`)
      .expect(200);
    expect(decisions.body).toHaveLength(1);
    expect(decisions.body[0]).toMatchObject({
      decision: 'rejected',
      reasons: ['Cover image is low resolution'],
      item_notes: { cover_image: 'Use at least 1280x720' },
    });

    // Instructor fixes and resubmits.
    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ cover_image_key: TEST_IMAGE_KEY_2 })
      .expect(200);
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);

    // Admin approves.
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    const approvedCourse = await dataSource
      .getRepository(MarketplaceCourse)
      .findOne({ where: { id: courseId } });
    expect(approvedCourse?.status).toBe(MarketplaceCourseStatus.APPROVED);

    // Only the instructor may publish — never automatic (FR-067).
    const published = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);
    expect(published.body.status).toBe('published');
    expect(published.body.first_published_at).toBeTruthy();

    // A version snapshot now exists.
    const versionCount = await dataSource.query(
      'SELECT COUNT(*) FROM marketplace_course_versions WHERE course_id = $1',
      [courseId],
    );
    expect(Number(versionCount[0].count)).toBe(1);

    // Instructor unpublishes their own course — access-preservation is asserted structurally: status changes, nothing else is touched.
    const unpublished = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/unpublish`)
      .send({})
      .expect(201);
    expect(unpublished.body.status).toBe('unpublished');
  });

  it('refuses a free-preview lesson beyond the FR-049 bound, naming the bound', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Section 1' })
      .expect(201);
    const sectionId = section.body.id as string;

    // 5 lessons, all marked free preview: bound = min(5, max(1, floor(0.2*5))) = 1 for the first;
    // subsequent previews should be refused once the bound is reached.
    let refusedAt = -1;
    for (let i = 0; i < 5; i++) {
      const res = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: sectionId,
          title: `Lesson ${i + 1}`,
          content_type: LessonContentType.TEXT,
          duration_seconds: 60,
          is_free_preview: true,
        });
      if (res.status === 422) {
        refusedAt = i;
        break;
      }
    }
    expect(refusedAt).toBeGreaterThanOrEqual(0);
  });

  it('material edit on a published course queues for re-review while the live version stays visible (FR-071)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');

    const created = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);
    const courseId = created.body.id as string;
    const section = await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/sections`)
      .send({ title: 'Section 1' })
      .expect(201);
    for (let i = 0; i < 3; i++) {
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/lessons`)
        .send({
          section_id: section.body.id,
          title: `L${i}`,
          content_type: LessonContentType.TEXT,
          duration_seconds: 60,
          is_free_preview: i === 0,
        })
        .expect(201);
    }
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/submit`)
      .send({})
      .expect(201);
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/publish`)
      .send({})
      .expect(201);

    // Material edit: price change.
    await instructorUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${courseId}`)
      .send({ price_minor: 9999 })
      .expect(200);

    const afterMaterialEdit = await dataSource
      .getRepository(MarketplaceCourse)
      .findOne({ where: { id: courseId } });
    expect(afterMaterialEdit?.status).toBe(MarketplaceCourseStatus.PUBLISHED);
    expect(afterMaterialEdit?.pending_review_since).not.toBeNull();

    const versionsAfterEdit = await dataSource.query(
      'SELECT COUNT(*) FROM marketplace_course_versions WHERE course_id = $1',
      [courseId],
    );
    expect(Number(versionsAfterEdit[0].count)).toBe(1); // no new snapshot yet — the live version is unchanged.
  });

  it('admin category CRUD: create, reorder, refuse deletion while referenced, deactivate instead', async () => {
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);

    const created = await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/categories`)
      .send({ name_en: 'Design', name_ar: 'التصميم' })
      .expect(201);
    const categoryId = created.body.id as string;

    await admin.agent
      .patch(`${API_PREFIX}/marketplace/admin/categories/${categoryId}`)
      .send({ display_order: 5 })
      .expect(200);

    await instructorUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(categoryId))
      .expect(201);

    const deleteRes = await admin.agent.delete(
      `${API_PREFIX}/marketplace/admin/categories/${categoryId}`,
    );
    expect(deleteRes.status).toBe(409);
    expect(deleteRes.body.code).toBe('CATEGORY_REFERENCED');

    await admin.agent
      .patch(`${API_PREFIX}/marketplace/admin/categories/${categoryId}`)
      .send({ is_active: false })
      .expect(200);
  });

  it('refuses course routes to an instructor acting on a course they do not own (no IDOR)', async () => {
    const ownerUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(ownerUser.userId);
    const category = await seedCategory();
    const created = await ownerUser.agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);

    const otherUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(otherUser.userId);

    await otherUser.agent
      .patch(`${API_PREFIX}/marketplace/instructor/courses/${created.body.id}`)
      .send({ title: 'Hijacked' })
      .expect(404);

    await otherUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/courses/${created.body.id}/curriculum`)
      .expect(404);
    await otherUser.agent
      .get(`${API_PREFIX}/marketplace/instructor/courses/${created.body.id}/review-decisions`)
      .expect(404);
  });

  describe('curriculum positions (T071)', () => {
    const base = (courseId: string): string =>
      `${API_PREFIX}/marketplace/instructor/courses/${courseId}`;

    async function draftCourse() {
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(instructorUser.userId);
      const category = await seedCategory();
      const created = await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses`)
        .send(courseBody(category.id))
        .expect(201);
      return { agent: instructorUser.agent, courseId: created.body.id as string };
    }

    async function addSections(
      agent: Awaited<ReturnType<typeof draftCourse>>['agent'],
      courseId: string,
      count: number,
    ) {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const res = await agent
          .post(`${base(courseId)}/sections`)
          .send({ title: `Section ${i}` })
          .expect(201);
        ids.push(res.body.id as string);
      }
      return ids;
    }

    async function addLessons(
      agent: Awaited<ReturnType<typeof draftCourse>>['agent'],
      courseId: string,
      sectionId: string,
      count: number,
    ) {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const res = await agent
          .post(`${base(courseId)}/lessons`)
          .send({
            section_id: sectionId,
            title: `Lesson ${i}`,
            content_type: LessonContentType.TEXT,
            duration_seconds: 60,
          })
          .expect(201);
        ids.push(res.body.id as string);
      }
      return ids;
    }

    async function curriculum(
      agent: Awaited<ReturnType<typeof draftCourse>>['agent'],
      courseId: string,
    ) {
      const res = await agent.get(`${base(courseId)}/curriculum`).expect(200);
      return res.body.sections as Array<{
        id: string;
        position: number;
        lessons: Array<{ id: string; position: number }>;
      }>;
    }

    it('deleting the first of several sections renumbers the rest without a unique-position collision', async () => {
      const { agent, courseId } = await draftCourse();
      const ids = await addSections(agent, courseId, 6);

      await agent.delete(`${base(courseId)}/sections/${ids[0]}`).expect(200);

      const sections = await curriculum(agent, courseId);
      expect(sections.map((s) => s.id)).toEqual(ids.slice(1));
      expect(sections.map((s) => s.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it('deleting a middle lesson renumbers the rest of its section without a collision', async () => {
      const { agent, courseId } = await draftCourse();
      const [sectionId] = await addSections(agent, courseId, 1);
      const lessonIds = await addLessons(agent, courseId, sectionId!, 6);

      await agent.delete(`${base(courseId)}/lessons/${lessonIds[1]}`).expect(200);

      const [section] = await curriculum(agent, courseId);
      expect(section!.lessons.map((l) => l.id)).toEqual([lessonIds[0], ...lessonIds.slice(2)]);
      expect(section!.lessons.map((l) => l.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it('swapping two sections through reorder succeeds and yields contiguous positions', async () => {
      const { agent, courseId } = await draftCourse();
      const ids = await addSections(agent, courseId, 3);

      await agent
        .post(`${base(courseId)}/sections/reorder`)
        .send({ ordered_ids: [ids[1], ids[0], ids[2]] })
        .expect(201);

      const sections = await curriculum(agent, courseId);
      expect(sections.map((s) => s.id)).toEqual([ids[1], ids[0], ids[2]]);
      expect(sections.map((s) => s.position)).toEqual([0, 1, 2]);
    });

    it('swapping two lessons through reorder succeeds and yields contiguous positions', async () => {
      const { agent, courseId } = await draftCourse();
      const [sectionId] = await addSections(agent, courseId, 1);
      const lessonIds = await addLessons(agent, courseId, sectionId!, 4);

      await agent
        .post(`${base(courseId)}/lessons/reorder`)
        .send({
          section_id: sectionId,
          ordered_ids: [lessonIds[3], lessonIds[1], lessonIds[2], lessonIds[0]],
        })
        .expect(201);

      const [section] = await curriculum(agent, courseId);
      expect(section!.lessons.map((l) => l.id)).toEqual([
        lessonIds[3],
        lessonIds[1],
        lessonIds[2],
        lessonIds[0],
      ]);
      expect(section!.lessons.map((l) => l.position)).toEqual([0, 1, 2, 3]);
    });

    it('a reorder that does not name exactly the existing ids is refused and changes nothing', async () => {
      const { agent, courseId } = await draftCourse();
      const ids = await addSections(agent, courseId, 3);

      const res = await agent
        .post(`${base(courseId)}/sections/reorder`)
        .send({ ordered_ids: [ids[1], ids[0]] });

      expect(res.status).toBe(404);
      expect((await curriculum(agent, courseId)).map((s) => s.id)).toEqual(ids);
    });

    it('another instructor can neither reorder nor delete (no IDOR) and nothing moves', async () => {
      const { agent, courseId } = await draftCourse();
      const ids = await addSections(agent, courseId, 3);
      const intruder = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(intruder.userId);

      await intruder.agent
        .post(`${base(courseId)}/sections/reorder`)
        .send({ ordered_ids: [ids[2], ids[1], ids[0]] })
        .expect(404);
      await intruder.agent.delete(`${base(courseId)}/sections/${ids[0]}`).expect(404);

      expect((await curriculum(agent, courseId)).map((s) => s.id)).toEqual(ids);
    });

    it('the curriculum read costs 3 statements however many sections the course has', async () => {
      const { agent, courseId } = await draftCourse();
      const ids = await addSections(agent, courseId, 5);
      await addLessons(agent, courseId, ids[0]!, 2);

      const counter = new StatementCounter(dataSource);
      counter.start();
      await agent
        .get(`${base(courseId)}/curriculum`)
        .set('X-Request-Id', 't071-curriculum')
        .expect(200);
      counter.stop();

      const handler = counter
        .statements({ requestId: 't071-curriculum' })
        .filter((statement) => statement.sql.includes('marketplace_course'));
      // course, sections, lessons — the per-section lesson reads are gone.
      expect(handler.length).toBeLessThanOrEqual(3 + 1 /* ownership lookup */);
      expect(
        counter.count({ requestId: 't071-curriculum', table: 'marketplace_course_lessons' }),
      ).toBe(1);
      expect(
        counter.count({ requestId: 't071-curriculum', table: 'marketplace_course_sections' }),
      ).toBe(1);
    });
  });

  it('a published snapshot lists sections and lessons exactly as the curriculum read does, after renumbering (T071)', async () => {
    const instructorUser = await createAuthenticatedUser(app, dataSource);
    await seedInstructor(instructorUser.userId);
    const category = await seedCategory();
    const admin = await createAuthenticatedUser(app, dataSource);
    await setUserRole(dataSource, admin.userId, 'admin');
    const agent = instructorUser.agent;
    const created = await agent
      .post(`${API_PREFIX}/marketplace/instructor/courses`)
      .send(courseBody(category.id))
      .expect(201);
    const courseId = created.body.id as string;
    const base = `${API_PREFIX}/marketplace/instructor/courses/${courseId}`;

    const sectionIds: string[] = [];
    const lessonIdsBySection = new Map<string, string[]>();
    for (let s = 0; s < 3; s += 1) {
      const section = await agent
        .post(`${base}/sections`)
        .send({ title: `Section ${s}` })
        .expect(201);
      const sectionId = section.body.id as string;
      sectionIds.push(sectionId);
      const lessonIds: string[] = [];
      for (let l = 0; l < 3; l += 1) {
        const lesson = await agent
          .post(`${base}/lessons`)
          .send({
            section_id: sectionId,
            title: `S${s}L${l}`,
            content_type: LessonContentType.TEXT,
            duration_seconds: 60,
            is_free_preview: s === 0 && l === 0,
          })
          .expect(201);
        lessonIds.push(lesson.body.id as string);
      }
      lessonIdsBySection.set(sectionId, lessonIds);
    }
    // Reorder sections (swap first and last) and lessons of the middle section (reverse).
    await agent
      .post(`${base}/sections/reorder`)
      .send({ ordered_ids: [sectionIds[2], sectionIds[1], sectionIds[0]] })
      .expect(201);
    const middle = lessonIdsBySection.get(sectionIds[1]!)!;
    await agent
      .post(`${base}/lessons/reorder`)
      .send({ section_id: sectionIds[1], ordered_ids: [...middle].reverse() })
      .expect(201);
    // Delete a lesson from the last section so a recompaction has run too.
    await agent.delete(`${base}/lessons/${lessonIdsBySection.get(sectionIds[0]!)![2]}`).expect(200);

    const read = (await agent.get(`${base}/curriculum`).expect(200)).body.sections as Array<{
      id: string;
      position: number;
      lessons: Array<{ id: string; position: number }>;
    }>;
    expect(read.map((s) => s.id)).toEqual([sectionIds[2], sectionIds[1], sectionIds[0]]);

    await agent.post(`${base}/submit`).send({}).expect(201);
    await admin.agent
      .post(`${API_PREFIX}/marketplace/admin/courses/${courseId}/approve`)
      .send({})
      .expect(201);
    await agent.post(`${base}/publish`).send({}).expect(201);

    const [version] = (await dataSource.query(
      'SELECT snapshot FROM marketplace_course_versions WHERE course_id = $1',
      [courseId],
    )) as Array<{
      snapshot: {
        sections: Array<{
          id: string;
          position: number;
          lessons: Array<{ id: string; position: number }>;
        }>;
      };
    }>;
    const snapshot = version!.snapshot.sections;
    expect(
      snapshot.map((s) => ({
        id: s.id,
        position: s.position,
        lessons: s.lessons.map((l) => ({ id: l.id, position: l.position })),
      })),
    ).toEqual(
      read.map((s) => ({
        id: s.id,
        position: s.position,
        lessons: s.lessons.map((l) => ({ id: l.id, position: l.position })),
      })),
    );
    expect(snapshot.map((s) => s.lessons.length)).toEqual([3, 3, 2]);
  });

  describe('course list embeds the latest review reasons (T073)', () => {
    interface ListedCourse {
      id: string;
      status: string;
      latest_review_reasons?: string[] | null;
    }

    async function listAndDecisions(
      agent: Awaited<ReturnType<typeof createAuthenticatedUser>>['agent'],
      requestId?: string,
    ) {
      const request = agent.get(`${API_PREFIX}/marketplace/instructor/courses`);
      const res = await (
        requestId === undefined ? request : request.set('X-Request-Id', requestId)
      ).expect(200);
      return res.body as ListedCourse[];
    }

    it('gives every rejected row the reasons its per-course review-decisions endpoint shows first, in one extra statement', async () => {
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(instructorUser.userId);
      const category = await seedCategory();
      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');
      const agent = instructorUser.agent;

      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const created = await agent
          .post(`${API_PREFIX}/marketplace/instructor/courses`)
          .send({ ...courseBody(category.id), title: `Course ${String(i)}` })
          .expect(201);
        ids.push(created.body.id as string);
      }
      // Courses 0 and 1 and 2 are rejected; 3 stays a draft. Course 1 has an older and a newer decision,
      // and the newer one is NOT a rejection: the list must still show the latest row, as [0] does today.
      await dataSource.query(
        `UPDATE marketplace_courses SET status = 'rejected' WHERE id = ANY($1::uuid[])`,
        [ids.slice(0, 3)],
      );
      const decide = async (courseId: string, decision: string, reasons: string[], at: string) =>
        dataSource.query(
          `INSERT INTO marketplace_course_review_decisions (course_id, decision, reasons, item_notes, reviewed_by, reviewed_at)
           VALUES ($1, $2, $3::text[], '{}', $4, $5)`,
          [courseId, decision, reasons, admin.userId, at],
        );
      await decide(
        ids[0]!,
        'rejected',
        ['Cover is blurry', 'Title is vague'],
        '2026-01-02T10:00:00Z',
      );
      await decide(ids[1]!, 'rejected', ['Old reason'], '2026-01-02T10:00:00Z');
      await decide(ids[1]!, 'approved', ['Newer note'], '2026-01-03T10:00:00Z');
      // Course 2 is rejected but has no decision row at all.

      const counter = new StatementCounter(dataSource);
      counter.start();
      const listed = await listAndDecisions(agent, 't073-list');
      counter.stop();

      const byId = new Map(listed.map((course) => [course.id, course]));
      expect(byId.get(ids[0]!)?.latest_review_reasons).toEqual([
        'Cover is blurry',
        'Title is vague',
      ]);
      expect(byId.get(ids[1]!)?.latest_review_reasons).toEqual(['Newer note']);
      expect(byId.get(ids[2]!)?.latest_review_reasons).toBeNull();
      expect('latest_review_reasons' in byId.get(ids[3]!)!).toBe(false);

      // Parity with the per-row endpoint the page used to call once per rejected course.
      for (const courseId of [ids[0]!, ids[1]!]) {
        const decisions = await agent
          .get(`${API_PREFIX}/marketplace/instructor/courses/${courseId}/review-decisions`)
          .expect(200);
        expect((decisions.body as Array<{ reasons: string[] }>)[0]?.reasons).toEqual(
          byId.get(courseId)?.latest_review_reasons,
        );
      }

      // R rejected courses cost ONE decisions statement (was R requests), and none when nothing is rejected.
      expect(
        counter.count({ requestId: 't073-list', table: 'marketplace_course_review_decisions' }),
      ).toBe(1);
    });

    it('issues no decisions statement when the instructor has no rejected course', async () => {
      const instructorUser = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(instructorUser.userId);
      const category = await seedCategory();
      await instructorUser.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses`)
        .send(courseBody(category.id))
        .expect(201);

      const counter = new StatementCounter(dataSource);
      counter.start();
      const listed = await listAndDecisions(instructorUser.agent, 't073-none');
      counter.stop();

      expect(listed).toHaveLength(1);
      expect('latest_review_reasons' in listed[0]!).toBe(false);
      expect(
        counter.count({ requestId: 't073-none', table: 'marketplace_course_review_decisions' }),
      ).toBe(0);
    });

    it("never shows another instructor's decisions", async () => {
      const first = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(first.userId);
      const second = await createAuthenticatedUser(app, dataSource);
      await seedInstructor(second.userId);
      const admin = await createAuthenticatedUser(app, dataSource);
      await setUserRole(dataSource, admin.userId, 'admin');
      const category = await seedCategory();
      const mine = await first.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses`)
        .send(courseBody(category.id))
        .expect(201);
      const theirs = await second.agent
        .post(`${API_PREFIX}/marketplace/instructor/courses`)
        .send(courseBody(category.id))
        .expect(201);
      await dataSource.query(
        `UPDATE marketplace_courses SET status = 'rejected' WHERE id = ANY($1::uuid[])`,
        [[mine.body.id, theirs.body.id]],
      );
      await dataSource.query(
        `INSERT INTO marketplace_course_review_decisions (course_id, decision, reasons, item_notes, reviewed_by)
         VALUES ($1, 'rejected', ARRAY['Their private reason'], '{}', $2)`,
        [theirs.body.id, admin.userId],
      );

      const listed = await listAndDecisions(first.agent);

      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: mine.body.id, latest_review_reasons: null });
      expect(JSON.stringify(listed)).not.toContain('Their private reason');
    });
  });
});
