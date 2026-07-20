import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import {
  buildAbsoluteUrl,
  getConfiguredPublicOrigin,
} from '../../config/public-url.util';
import { biBody } from '../../i18n/error-translator.util';
import { StorageObjectNotFoundError, StoredObject } from '../../storage/storage.interface';
import { StorageService } from '../../storage/storage.service';
import { BookFilterDto } from '../dto';
import { Book } from '../entities/book.entity';
import { BookPurchase } from '../entities/book-purchase.entity';
import { BooksService } from './books.service';

// Type interfaces for raw query results
interface BookPurchaseStatsRaw {
  total_purchases: string;
  total_revenue: string;
  avg_price: string;
}

interface TeacherBookRevenueRaw {
  book_id: string;
  book_title: string;
  sales: string;
  revenue: string;
}

@Injectable()
export class BookPurchasesService {
  private readonly logger = new Logger(BookPurchasesService.name);

  constructor(
    @InjectRepository(BookPurchase)
    private readonly purchasesRepository: Repository<BookPurchase>,
    private readonly booksService: BooksService,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Create a book purchase record
   * Called after successful payment
   */
  public async purchaseBook(
    studentId: string,
    bookId: string,
    paymentId: string,
    pricePaid: number,
  ): Promise<BookPurchase> {
    // Check if already purchased
    const existing = await this.checkAlreadyPurchased(studentId, bookId);
    if (existing) {
      throw new ConflictException(
        biBody('You have already purchased this book', 'لقد قمت بشراء هذا الكتاب بالفعل'),
      );
    }

    // Verify book exists
    await this.booksService.findOne(bookId);

    // Create purchase record
    const purchase = this.purchasesRepository.create({
      student_id: studentId,
      book_id: bookId,
      payment_id: paymentId,
      price_paid: pricePaid,
    });

    const saved = await this.purchasesRepository.save(purchase);

    // Increment book purchase count
    await this.booksService.incrementPurchaseCount(bookId);

    this.logger.log(`Book purchased: book ${bookId} by student ${studentId}, payment ${paymentId}`);

    return await this.findPurchaseById(saved.id);
  }

  /**
   * Check if student already purchased a book
   */
  public async checkAlreadyPurchased(
    studentId: string,
    bookId: string,
  ): Promise<BookPurchase | null> {
    return await this.purchasesRepository.findOne({
      where: {
        student_id: studentId,
        book_id: bookId,
      },
    });
  }

  /**
   * Get student's purchased books
   */
  public async getMyBooks(
    studentId: string,
    filter: BookFilterDto,
  ): Promise<{ data: BookPurchase[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const query = this.purchasesRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.book', 'book')
      .leftJoinAndSelect('book.teacher', 'teacher')
      .leftJoinAndSelect('book.subject', 'subject')
      .where('purchase.student_id = :studentId', { studentId })
      .andWhere('book.deleted_at IS NULL');

    // Apply search filter
    if (filter.search !== undefined && filter.search !== '') {
      query.andWhere('(book.title ILIKE :search OR book.title_ar ILIKE :search)', {
        search: `%${filter.search}%`,
      });
    }

    // Apply subject filter
    if (filter.subject_id !== undefined && filter.subject_id !== '') {
      query.andWhere('book.subject_id = :subjectId', {
        subjectId: filter.subject_id,
      });
    }

    // Order by purchase date (newest first)
    query.orderBy('purchase.purchased_at', 'DESC').addOrderBy('purchase.id', 'DESC');

    // Get total count
    const total = await query.getCount();

    // Apply pagination
    query.skip(skip).take(limit);

    const purchases = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: purchases, meta };
  }

  /**
   * Get download URL for a purchased book
   * Validates the student has purchased the book
   */
  public async getDownloadUrl(
    studentId: string,
    bookId: string,
  ): Promise<{ download_url: string; book: Book }> {
    const book = await this.assertPurchasedBook(studentId, bookId);
    const backendUrl = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'BACKEND_URL',
      'http://localhost:3001',
    );
    const download_url = buildAbsoluteUrl(
      backendUrl,
      `/api/v1/student/books/${bookId}/download/file`,
    );

    this.logger.log(`Protected book download URL issued: book ${bookId}, student ${studentId}`);

    return { download_url, book };
  }

  /**
   * Stream a purchased book through the backend after authorization. This keeps
   * local private files off the public web root and avoids handing out direct
   * local filesystem URLs.
   */
  public async getDownloadObject(
    studentId: string,
    bookId: string,
  ): Promise<{ object: StoredObject; book: Book }> {
    const book = await this.assertPurchasedBook(studentId, bookId);
    const key = this.storageService.toKey(book.book_file);

    try {
      const object = await this.storageService.getObject(key);
      this.logger.log(`Protected book download streamed: book ${bookId}, student ${studentId}`);
      return { object, book };
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new NotFoundException(biBody('Book file not found', 'ملف الكتاب غير موجود'));
      }
      throw err;
    }
  }

  private async assertPurchasedBook(studentId: string, bookId: string): Promise<Book> {
    // Authorize FIRST: only a student who purchased the book gets a URL.
    const purchase = await this.checkAlreadyPurchased(studentId, bookId);

    if (!purchase) {
      throw new ForbiddenException(
        biBody('You have not purchased this book', 'لم تقم بشراء هذا الكتاب'),
      );
    }

    const book = await this.booksService.findOne(bookId);
    return book;
  }

  /**
   * Find purchase by ID
   */
  public async findPurchaseById(id: string): Promise<BookPurchase> {
    const purchase = await this.purchasesRepository.findOne({
      where: { id },
      relations: ['book', 'book.teacher', 'book.subject', 'student', 'payment'],
    });

    if (!purchase) {
      throw new NotFoundException(
        biBody(`Purchase with ID ${id} not found`, `عملية الشراء بالمعرّف ${id} غير موجودة`),
      );
    }

    return purchase;
  }

  /**
   * Get all purchases (admin view)
   */
  public async getAllPurchases(filter: BookFilterDto): Promise<{
    data: BookPurchase[];
    meta: PaginationMeta;
  }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;

    const query = this.purchasesRepository
      .createQueryBuilder('purchase')
      .leftJoinAndSelect('purchase.book', 'book')
      .leftJoinAndSelect('book.teacher', 'teacher')
      .leftJoinAndSelect('book.subject', 'subject')
      .leftJoinAndSelect('purchase.student', 'student')
      .leftJoinAndSelect('purchase.payment', 'payment');

    // Apply search filter
    if (filter.search !== undefined && filter.search !== '') {
      query.andWhere('(book.title ILIKE :search OR book.title_ar ILIKE :search)', {
        search: `%${filter.search}%`,
      });
    }

    // Apply subject filter
    if (filter.subject_id !== undefined && filter.subject_id !== '') {
      query.andWhere('book.subject_id = :subjectId', {
        subjectId: filter.subject_id,
      });
    }

    // Apply teacher filter
    if (filter.teacher_id !== undefined && filter.teacher_id !== '') {
      query.andWhere('book.teacher_id = :teacherId', {
        teacherId: filter.teacher_id,
      });
    }

    // Order by purchase date (newest first)
    query.orderBy('purchase.purchased_at', 'DESC').addOrderBy('purchase.id', 'DESC');

    // Get total count
    const total = await query.getCount();

    // Apply pagination
    query.skip(skip).take(limit);

    const purchases = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: purchases, meta };
  }

  /**
   * Get purchase statistics for a book
   */
  public async getBookPurchaseStats(bookId: string): Promise<{
    total_purchases: number;
    total_revenue: number;
    avg_price: number;
  }> {
    const result = await this.purchasesRepository
      .createQueryBuilder('purchase')
      .where('purchase.book_id = :bookId', { bookId })
      .select([
        'COUNT(purchase.id) as total_purchases',
        'SUM(purchase.price_paid) as total_revenue',
        'AVG(purchase.price_paid) as avg_price',
      ])
      .getRawOne<BookPurchaseStatsRaw>();

    const totalPurchases = Number(result?.total_purchases);
    const totalRevenue = Number(result?.total_revenue);
    const avgPrice = Number(result?.avg_price);

    return {
      total_purchases: Number.isNaN(totalPurchases) ? 0 : totalPurchases,
      total_revenue: Number.isNaN(totalRevenue) ? 0 : totalRevenue,
      avg_price: Number.isNaN(avgPrice) ? 0 : avgPrice,
    };
  }

  /**
   * Get teacher's book revenue
   */
  public async getTeacherBookRevenue(teacherId: string): Promise<{
    total_revenue: number;
    total_sales: number;
    books: Array<{
      book_id: string;
      book_title: string;
      sales: number;
      revenue: number;
    }>;
  }> {
    const results = await this.purchasesRepository
      .createQueryBuilder('purchase')
      .innerJoin('purchase.book', 'book')
      .where('book.teacher_id = :teacherId', { teacherId })
      .andWhere('book.deleted_at IS NULL')
      .select([
        'book.id as book_id',
        'book.title as book_title',
        'COUNT(purchase.id) as sales',
        'SUM(purchase.price_paid) as revenue',
      ])
      .groupBy('book.id, book.title')
      .orderBy('revenue', 'DESC')
      .getRawMany<TeacherBookRevenueRaw>();

    const totals = results.reduce(
      (acc, row) => ({
        total_revenue: acc.total_revenue + Number(row.revenue),
        total_sales: acc.total_sales + Number(row.sales),
      }),
      { total_revenue: 0, total_sales: 0 },
    );

    return {
      ...totals,
      books: results.map((row) => ({
        book_id: row.book_id,
        book_title: row.book_title,
        sales: Number(row.sales),
        revenue: Number(row.revenue),
      })),
    };
  }
}
