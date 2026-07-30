import { BooksService } from './books.service';

describe('BooksService title compatibility', () => {
  const teacherId = 'teacher-id';
  const subject = { id: 'subject-id', deleted_at: null };
  const storage = { toKey: jest.fn(), tryDelete: jest.fn() };

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
      storage as never,
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
      storage as never,
    );

    await service.update(book.id, teacherId, { title: 'Advanced Algebra' });

    expect(book.title_ar).toBe('Advanced Algebra');
    expect(books.save).toHaveBeenCalledWith(book);
  });
});
