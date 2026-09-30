import { BooksService } from './books.service';

describe('BooksService title compatibility', () => {
  const teacherId = 'teacher-id';
  const subject = { id: 'subject-id', deleted_at: null };
  const storage = { toKey: jest.fn(), tryDelete: jest.fn() };
  const applicationCache = {
    getOrCompute: jest.fn((_descriptor: unknown, compute: () => unknown) => compute()),
  };

  it('mirrors a new single title into the legacy title_ar column when creating a book', async () => {
    const books = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'book-id', title: 'Algebra', title_ar: 'Algebra' }),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue({ id: 'book-id' }),
    };
    const service = new BooksService(
      books as never,
      { findOne: jest.fn().mockResolvedValue(subject) } as never,
      {} as never,
      storage as never,
      applicationCache as never,
    );

    await service.create(teacherId, {
      title: 'Algebra',
      subject_id: subject.id,
      price: 50,
      book_file: `books/${teacherId}/book.pdf`,
    });

    expect(books.create).toHaveBeenCalledWith(
      expect.objectContaining({ teacher_id: teacherId, title: 'Algebra', title_ar: 'Algebra' }),
    );
  });

  it('keeps the legacy title_ar column synchronized when a title is edited', async () => {
    const book = {
      id: 'book-id',
      teacher_id: teacherId,
      title: 'Algebra',
      title_ar: 'Algebra',
      book_file: `books/${teacherId}/book.pdf`,
      cover_image: null,
    };
    const books = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(book)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(book),
      save: jest.fn().mockResolvedValue(book),
    };
    const service = new BooksService(
      books as never,
      { findOne: jest.fn() } as never,
      {} as never,
      storage as never,
      applicationCache as never,
    );

    await service.update(book.id, teacherId, { title: 'Advanced Algebra' });

    expect(book.title_ar).toBe('Advanced Algebra');
    expect(books.save).toHaveBeenCalledWith(book);
  });

  it('refuses an irreversible deletion when purchase history exists', async () => {
    const book = {
      id: 'book-id',
      book_file: `books/${teacherId}/book.pdf`,
      cover_image: null,
    };
    const purchases = { exist: jest.fn().mockResolvedValue(true) };
    const books = { findOne: jest.fn().mockResolvedValue(book), remove: jest.fn() };
    const service = new BooksService(
      books as never,
      {} as never,
      purchases as never,
      storage as never,
      applicationCache as never,
    );

    await expect(service.hardDelete(book.id)).rejects.toThrow(
      'A purchased book cannot be permanently deleted',
    );
    expect(books.remove).not.toHaveBeenCalled();
    expect(storage.tryDelete).not.toHaveBeenCalled();
  });

  describe('adminDelete', () => {
    it('soft deletes an existing book regardless of owner', async () => {
      const book = { id: 'book-id', teacher_id: 'some-other-teacher', deleted_at: null };
      const books = {
        findOne: jest.fn().mockResolvedValue(book),
        softDelete: jest.fn().mockResolvedValue(undefined),
      };
      const service = new BooksService(books as never, {} as never, {} as never, storage as never, applicationCache as never);

      await service.adminDelete(book.id);

      expect(books.softDelete).toHaveBeenCalledWith(book.id);
    });

    it('throws NotFoundException when the book does not exist', async () => {
      const books = { findOne: jest.fn().mockResolvedValue(null), softDelete: jest.fn() };
      const service = new BooksService(books as never, {} as never, {} as never, storage as never, applicationCache as never);

      await expect(service.adminDelete('missing-id')).rejects.toThrow('not found');
      expect(books.softDelete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the book is already soft deleted', async () => {
      // adminDelete queries with deleted_at: IsNull(), so an already-deleted
      // book resolves to null from the repository — same as a missing book.
      const books = { findOne: jest.fn().mockResolvedValue(null), softDelete: jest.fn() };
      const service = new BooksService(books as never, {} as never, {} as never, storage as never, applicationCache as never);

      await expect(service.adminDelete('already-deleted-id')).rejects.toThrow('not found');
      expect(books.softDelete).not.toHaveBeenCalled();
    });

    it('soft deletes a book that has purchase history, unlike hardDelete', async () => {
      const book = { id: 'book-id', teacher_id: teacherId, deleted_at: null };
      const books = {
        findOne: jest.fn().mockResolvedValue(book),
        softDelete: jest.fn().mockResolvedValue(undefined),
      };
      // No bookPurchasesRepository call is made by adminDelete at all —
      // passing an empty mock proves the purchase-history check from
      // hardDelete does not apply to the soft-delete path.
      const service = new BooksService(books as never, {} as never, {} as never, storage as never, applicationCache as never);

      await service.adminDelete(book.id);

      expect(books.softDelete).toHaveBeenCalledWith(book.id);
      expect(storage.tryDelete).not.toHaveBeenCalled();
    });
  });
});
