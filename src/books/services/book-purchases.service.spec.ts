import { ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../storage/storage.service';
import { Book } from '../entities/book.entity';
import { BookPurchase } from '../entities/book-purchase.entity';
import { BookPurchasesService } from './book-purchases.service';
import { BooksService } from './books.service';

describe('BookPurchasesService protected downloads', () => {
  const purchases = { findOne: jest.fn() };
  const books = { findOneRetained: jest.fn() };
  const storage = { toKey: jest.fn(), getObject: jest.fn() };
  const config = { get: jest.fn() };
  let service: BookPurchasesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BookPurchasesService(
      purchases as unknown as Repository<BookPurchase>,
      books as unknown as BooksService,
      storage as unknown as StorageService,
      config as unknown as ConfigService,
    );
  });

  it('rejects an unpurchased book before resolving its storage object', async () => {
    purchases.findOne.mockResolvedValue(null);

    await expect(service.getDownloadObject('student-1', 'book-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(books.findOneRetained).not.toHaveBeenCalled();
    expect(storage.toKey).not.toHaveBeenCalled();
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it('streams the purchased book only after the purchase check succeeds', async () => {
    const book = { id: 'book-1', book_file: 'books/student-1/private.pdf' } as Book;
    purchases.findOne.mockResolvedValue({ id: 'purchase-1' });
    books.findOneRetained.mockResolvedValue(book);
    storage.toKey.mockReturnValue('books/student-1/private.pdf');
    storage.getObject.mockResolvedValue({ body: Buffer.from('pdf') });

    await expect(service.getDownloadObject('student-1', 'book-1')).resolves.toMatchObject({ book });

    expect(storage.getObject).toHaveBeenCalledWith('books/student-1/private.pdf');
  });
});

describe('BookPurchasesService revenue reporting', () => {
  it('excludes revoked purchases from per-book revenue', async () => {
    const query = {
      where: jest.fn(),
      andWhere: jest.fn(),
      select: jest.fn(),
      getRawOne: jest.fn().mockResolvedValue({
        total_purchases: '1',
        total_revenue: '100',
        avg_price: '100',
      }),
    };
    query.where.mockReturnValue(query);
    query.andWhere.mockReturnValue(query);
    query.select.mockReturnValue(query);
    const purchases = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const service = new BookPurchasesService(
      purchases as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.getBookPurchaseStats('book-1');

    expect(query.andWhere).toHaveBeenCalledWith('purchase.revoked_at IS NULL');
  });
});
