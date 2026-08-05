import type { Server } from 'node:http';

import request from 'supertest';

import {
  API_PREFIX,
  createAuthenticatedUser,
  createE2EApp,
  resetDatabase,
  type AuthenticatedUser,
  type E2EContext,
} from './fixtures';

/**
 * Admin book deletion: DELETE /admin/books/:id (soft delete).
 *
 * This is the route the /admin/books frontend page calls. It used to be
 * missing entirely (only .../:id/permanent and .../:id/restore existed),
 * which made every delete click 404. The invariants under test:
 *   - only an admin may call it;
 *   - a missing/already-deleted book 404s with a clear message;
 *   - a book with purchase history is still *soft* deletable (unlike the
 *     permanent-delete route, which refuses when purchases exist);
 *   - the delete never touches the `book_purchases` rows — it only flips
 *     `deleted_at` on the book.
 */
describe('Admin book deletion (e2e)', () => {
  let ctx: E2EContext;
  let server: Server;

  let admin: AuthenticatedUser;
  let teacher: AuthenticatedUser;
  let student: AuthenticatedUser;

  beforeAll(async () => {
    ctx = await createE2EApp();
    server = ctx.app.getHttpServer() as Server;
  });

  beforeEach(async () => {
    await resetDatabase(ctx.dataSource);
    admin = await createAuthenticatedUser(ctx.app, ctx.dataSource, { role: 'admin' });
    teacher = await createAuthenticatedUser(ctx.app, ctx.dataSource, {
      role: 'teacher',
      overrides: { requestedRole: 'teacher' },
    });
    student = await createAuthenticatedUser(ctx.app, ctx.dataSource);
  });

  afterAll(async () => ctx.app.close());

  /** Insert a subject + book directly, bypassing the upload/ownership flow. */
  async function createBook(teacherId: string, title: string): Promise<string> {
    const [{ id: subjectId }] = (await ctx.dataSource.query(
      `INSERT INTO subjects (id, name) VALUES (gen_random_uuid(), $1) RETURNING id`,
      [`Subject for ${title}`],
    )) as [{ id: string }];

    const [{ id: bookId }] = (await ctx.dataSource.query(
      `INSERT INTO books (id, title, title_ar, teacher_id, subject_id, book_file, price)
       VALUES (gen_random_uuid(), $1, $1, $2, $3, $4, 100)
       RETURNING id`,
      [title, teacherId, subjectId, `books/${teacherId}/${title}.pdf`],
    )) as [{ id: string }];

    return bookId;
  }

  /** Record a completed purchase of `bookId` by `studentId`. */
  async function purchaseBook(studentId: string, bookId: string): Promise<void> {
    const [{ id: paymentId }] = (await ctx.dataSource.query(
      `INSERT INTO payments (id, user_id, item_type, item_id, amount, final_amount, idempotency_key)
       VALUES (gen_random_uuid(), $1, 'book', $2, 100, 100, $3)
       RETURNING id`,
      [studentId, bookId, `idem-${studentId}-${bookId}`],
    )) as [{ id: string }];

    await ctx.dataSource.query(
      `INSERT INTO book_purchases (id, student_id, book_id, payment_id, price_paid)
       VALUES (gen_random_uuid(), $1, $2, $3, 100)`,
      [studentId, bookId, paymentId],
    );
  }

  async function isSoftDeleted(bookId: string): Promise<boolean> {
    const [row] = (await ctx.dataSource.query(
      `SELECT deleted_at FROM books WHERE id = $1`,
      [bookId],
    )) as [{ deleted_at: Date | null }];
    return row.deleted_at !== null;
  }

  describe('happy path', () => {
    it('soft deletes an existing book', async () => {
      const bookId = await createBook(teacher.userId, 'Algebra Basics');

      const res = await admin.agent
        .delete(`${API_PREFIX}/admin/books/${bookId}`)
        .expect(200);
      expect((res.body as { message: string }).message).toMatch(/deleted/i);

      expect(await isSoftDeleted(bookId)).toBe(true);
      // Removed from the public catalogue, but still resolvable by admin.
      await request(server).get(`${API_PREFIX}/books/${bookId}`).expect(404);
      await admin.agent.get(`${API_PREFIX}/admin/books/${bookId}`).expect(200);
    });

    it('soft deletes a book that has purchase history without touching the purchase row', async () => {
      const bookId = await createBook(teacher.userId, 'Purchased Book');
      await purchaseBook(student.userId, bookId);

      await admin.agent.delete(`${API_PREFIX}/admin/books/${bookId}`).expect(200);

      expect(await isSoftDeleted(bookId)).toBe(true);
      const purchases = (await ctx.dataSource.query(
        `SELECT id FROM book_purchases WHERE book_id = $1`,
        [bookId],
      )) as { id: string }[];
      expect(purchases).toHaveLength(1);
    });
  });

  describe('not found', () => {
    it('404s for a book id that does not exist', async () => {
      await admin.agent
        .delete(`${API_PREFIX}/admin/books/00000000-0000-0000-0000-000000000000`)
        .expect(404);
    });

    it('404s for a book that was already soft deleted', async () => {
      const bookId = await createBook(teacher.userId, 'Already Gone');
      await admin.agent.delete(`${API_PREFIX}/admin/books/${bookId}`).expect(200);

      await admin.agent.delete(`${API_PREFIX}/admin/books/${bookId}`).expect(404);
    });

    it('400s for a malformed id instead of a raw 500', async () => {
      await admin.agent.delete(`${API_PREFIX}/admin/books/not-a-uuid`).expect(400);
    });
  });

  describe('access control', () => {
    it('rejects anonymous, student, and teacher callers', async () => {
      const bookId = await createBook(teacher.userId, 'Guarded Book');

      await request(server).delete(`${API_PREFIX}/admin/books/${bookId}`).expect(401);
      await student.agent.delete(`${API_PREFIX}/admin/books/${bookId}`).expect(403);
      // Even the book's own teacher/owner may not use the admin route.
      await teacher.agent.delete(`${API_PREFIX}/admin/books/${bookId}`).expect(403);

      // Unaffected by the rejected attempts above.
      expect(await isSoftDeleted(bookId)).toBe(false);
    });
  });
});
