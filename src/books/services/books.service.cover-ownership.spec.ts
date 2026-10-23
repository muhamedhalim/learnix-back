import { BadRequestException } from '@nestjs/common';

import { BooksService } from './books.service';

/** F-03: a client-supplied cover reference must never authorise deleting someone else's object. */
describe('BooksService cover ownership', () => {
  const teacherId = 'teacher-2';
  const victimKey = 'images/teacher-1/victim-cover.jpg';
  const applicationCache = {
    getOrCompute: jest.fn((_d: unknown, compute: () => unknown) => compute()),
  };

  const build = (book: Record<string, unknown>, otherReferences = 0) => {
    const storage = { toKey: jest.fn((v: string) => v), tryDelete: jest.fn() };
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(otherReferences),
    };
    const books = {
      findOne: jest.fn().mockResolvedValue(book),
      save: jest.fn().mockResolvedValue(book),
      createQueryBuilder: jest.fn(() => qb),
    };
    const service = new BooksService(
      books as never,
      { findOne: jest.fn() } as never,
      {} as never,
      storage as never,
      applicationCache as never,
    );
    return { service, storage, books };
  };

  const ownBook = (cover: string | null) => ({
    id: 'book-id',
    teacher_id: teacherId,
    title: 'Algebra',
    title_ar: 'Algebra',
    book_file: `books/${teacherId}/book.pdf`,
    cover_image: cover,
  });

  it("rejects another teacher's object key as a new cover", async () => {
    const { service, storage } = build(ownBook(null));
    await expect(service.update('book-id', teacherId, { cover_image: victimKey })).rejects.toThrow(
      BadRequestException,
    );
    expect(storage.tryDelete).not.toHaveBeenCalled();
  });

  it('rejects traversal in an owned-looking cover key', async () => {
    const { service } = build(ownBook(null));
    await expect(
      service.update('book-id', teacherId, {
        cover_image: `images/${teacherId}/../teacher-1/x.jpg`,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('deletes the replaced cover only when the teacher owns it', async () => {
    const oldOwned = `images/${teacherId}/old.jpg`;
    const { service, storage } = build(ownBook(oldOwned));
    await service.update('book-id', teacherId, { cover_image: `images/${teacherId}/new.jpg` });
    expect(storage.tryDelete).toHaveBeenCalledWith(oldOwned);
  });

  it('never deletes a foreign cover left on a legacy row', async () => {
    const { service, storage } = build(ownBook(victimKey));
    await service.update('book-id', teacherId, { cover_image: `images/${teacherId}/new.jpg` });
    expect(storage.tryDelete).not.toHaveBeenCalled();
  });

  it('does not delete a legacy un-owned cover that another book still references', async () => {
    const { service, storage } = build(ownBook('images/legacy.jpg'), 1);
    await service.update('book-id', teacherId, { cover_image: `images/${teacherId}/new.jpg` });
    expect(storage.tryDelete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced legacy cover', async () => {
    const { service, storage } = build(ownBook('images/legacy.jpg'), 0);
    await service.update('book-id', teacherId, { cover_image: `images/${teacherId}/new.jpg` });
    expect(storage.tryDelete).toHaveBeenCalledWith('images/legacy.jpg');
  });
});
