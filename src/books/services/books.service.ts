import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { ApplicationCacheService } from '../../common/cache/application-cache.service';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { biBody } from '../../i18n/error-translator.util';
import { StorageService } from '../../storage/storage.service';
import { Subject } from '../../subjects/entities/subject.entity';
import { usableSubjectByIdWhere } from '../../subjects/subject-visibility.util';
import { BookFilterDto, CreateBookDto, UpdateBookDto } from '../dto';
import { Book } from '../entities/book.entity';
import { BookPurchase } from '../entities/book-purchase.entity';

/** T038 (W1-C6 d): anonymous, viewer-independent public catalog reads. */
const PUBLIC_CATALOG_CACHE_TTL_MS = 60_000;

@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    @InjectRepository(Book)
    private readonly booksRepository: Repository<Book>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
    @InjectRepository(BookPurchase)
    private readonly bookPurchasesRepository: Repository<BookPurchase>,
    private readonly storageService: StorageService,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  /**
   * Create a new book (teacher only)
   */
  public async create(teacherId: string, dto: CreateBookDto): Promise<Book> {
    this.assertOwnedBookFileReference(dto.book_file, teacherId);
    if (dto.cover_image != null && dto.cover_image !== '') {
      this.assertOwnedCoverReference(dto.cover_image, teacherId);
    }

    // Validate the subject exists and this teacher may use it (approved
    // catalogue, or their own pending submission)
    const subject = await this.subjectsRepository.findOne({
      where: usableSubjectByIdWhere(dto.subject_id, teacherId),
    });

    if (!subject) {
      throw new NotFoundException(
        biBody(
          `Subject with ID ${dto.subject_id} not found`,
          `المادة ذات المعرّف ${dto.subject_id} غير موجودة`,
        ),
      );
    }

    // Check for duplicate title by same teacher
    const existing = await this.booksRepository.findOne({
      where: {
        teacher_id: teacherId,
        title: dto.title,
        deleted_at: IsNull(),
      },
    });

    if (existing) {
      throw new ConflictException(
        biBody('You already have a book with this title', 'لديك بالفعل كتاب بهذا العنوان'),
      );
    }

    // The teacher-facing contract has one title. Keep the legacy localized
    // column in sync so existing records, search, and purchase snapshots keep
    // their current shape without a destructive schema migration.
    const book = this.booksRepository.create(
      Object.assign({}, dto, { teacher_id: teacherId, title_ar: dto.title }),
    );

    const saved = await this.booksRepository.save(book);
    this.logger.log(`Book created: ${saved.id} by teacher ${teacherId}`);

    return await this.findOne(saved.id);
  }

  /**
   * Find all books (public, with filters). Cached (T038, W1-C6 d): backs
   * `GET books` and (unauthenticated visibility is identical) the teacher's
   * own-books listing.
   */
  public async findAll(filter: BookFilterDto): Promise<{
    data: Book[];
    meta: PaginationMeta;
  }> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'books.list',
        scope: 'public',
        parts: [
          (filter.search ?? '').trim().toLowerCase(),
          filter.subject_id ?? null,
          filter.teacher_id ?? null,
          filter.sortBy ?? 'created_at',
          filter.order ?? 'desc',
          filter.page ?? 1,
          filter.limit ?? 20,
        ],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computeAll(filter),
    );
  }

  private async computeAll(filter: BookFilterDto): Promise<{
    data: Book[];
    meta: PaginationMeta;
  }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;
    const sortBy = filter.sortBy ?? 'created_at';
    const order = filter.order ?? 'desc';

    const query = this.booksRepository
      .createQueryBuilder('book')
      .leftJoinAndSelect('book.teacher', 'teacher')
      .leftJoinAndSelect('book.subject', 'subject')
      .where('book.deleted_at IS NULL');

    // Apply filters
    if (filter.search != null && filter.search !== '') {
      query.andWhere('(book.title ILIKE :search OR book.title_ar ILIKE :search)', {
        search: `%${filter.search}%`,
      });
    }

    if (filter.subject_id != null && filter.subject_id !== '') {
      query.andWhere('book.subject_id = :subjectId', {
        subjectId: filter.subject_id,
      });
    }

    if (filter.teacher_id != null && filter.teacher_id !== '') {
      query.andWhere('book.teacher_id = :teacherId', {
        teacherId: filter.teacher_id,
      });
    }

    // Apply sorting
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    query.orderBy(`book.${sortBy}`, sortOrder).addOrderBy('book.id', sortOrder);

    // Get total count
    const total = await query.getCount();

    // Apply pagination
    query.skip(skip).take(limit);

    const books = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: books, meta };
  }

  /**
   * Find teacher's own books
   */
  public async findMyBooks(
    teacherId: string,
    filter: Omit<BookFilterDto, 'teacher_id'>,
  ): Promise<{ data: Book[]; meta: PaginationMeta }> {
    return await this.findAll({ ...filter, teacher_id: teacherId });
  }

  /**
   * Find a single book by ID. Cached (T038, W1-C6 d); a 404 is thrown inside
   * the compute callback, so `getOrCompute` never stores a "not found" result.
   */
  public async findOne(id: string): Promise<Book> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'public_catalog',
        endpoint: 'books.detail',
        scope: 'public',
        parts: [id],
        ttlMs: PUBLIC_CATALOG_CACHE_TTL_MS,
      },
      async () => await this.computeOne(id),
    );
  }

  private async computeOne(id: string): Promise<Book> {
    const book = await this.booksRepository.findOne({
      where: { id, deleted_at: IsNull() },
      relations: ['teacher', 'subject'],
    });

    if (!book) {
      throw new NotFoundException(
        biBody(`Book with ID ${id} not found`, `الكتاب بالمعرّف ${id} غير موجود`),
      );
    }

    return book;
  }

  /**
   * Find a book by ID (including soft deleted, for admin)
   */
  public async findOneAdmin(id: string): Promise<Book> {
    const book = await this.booksRepository.findOne({
      where: { id },
      relations: ['teacher', 'subject'],
      withDeleted: true,
    });

    if (!book) {
      throw new NotFoundException(
        biBody(`Book with ID ${id} not found`, `الكتاب بالمعرّف ${id} غير موجود`),
      );
    }

    return book;
  }

  /**
   * Resolve a book retained for a verified historical purchaser. A soft delete
   * removes it from the storefront, but is never allowed to strand a buyer
   * who still has an active purchase entitlement.
   */
  public async findOneRetained(id: string): Promise<Book> {
    return await this.findOneAdmin(id);
  }

  /**
   * Update a book (teacher must own it)
   */
  public async update(id: string, teacherId: string, dto: UpdateBookDto): Promise<Book> {
    const book = await this.findOne(id);

    // Ownership validation
    if (book.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only update your own books', 'لا يمكنك تحديث سوى كتبك الخاصة'),
      );
    }

    if (dto.book_file != null && dto.book_file !== book.book_file) {
      this.assertOwnedBookFileReference(dto.book_file, teacherId);
    }
    if (dto.cover_image != null && dto.cover_image !== '' && dto.cover_image !== book.cover_image) {
      this.assertOwnedCoverReference(dto.cover_image, teacherId);
    }

    // If updating subject, validate it exists and is usable by this teacher.
    // Skipped when unchanged, so a later suspension does not brick editing.
    if (dto.subject_id != null && dto.subject_id !== '' && dto.subject_id !== book.subject_id) {
      const subject = await this.subjectsRepository.findOne({
        where: usableSubjectByIdWhere(dto.subject_id, teacherId),
      });

      if (!subject) {
        throw new NotFoundException(
          biBody(
            `Subject with ID ${dto.subject_id} not found`,
            `المادة ذات المعرّف ${dto.subject_id} غير موجودة`,
          ),
        );
      }
    }

    // If updating title, check for duplicates
    if (dto.title != null && dto.title !== '' && dto.title !== book.title) {
      const existing = await this.booksRepository.findOne({
        where: {
          teacher_id: teacherId,
          title: dto.title,
          deleted_at: IsNull(),
        },
      });

      if (existing && existing.id !== id) {
        throw new ConflictException(
          biBody('You already have a book with this title', 'لديك بالفعل كتاب بهذا العنوان'),
        );
      }
    }

    // Capture old asset refs before mutation so replaced files can be purged
    // from storage (avoid orphaned objects / leaked storage).
    const oldBookFile = book.book_file;
    const oldCover = book.cover_image;

    Object.assign(book, dto);
    if (dto.title != null && dto.title !== '') {
      // See create(): title_ar remains a persistence compatibility field.
      book.title_ar = dto.title;
    }
    await this.booksRepository.save(book);

    if (dto.book_file != null && dto.book_file !== oldBookFile) {
      await this.storageService.tryDelete(this.storageService.toKey(oldBookFile));
    }
    if (
      dto.cover_image != null &&
      oldCover != null &&
      oldCover !== '' &&
      dto.cover_image !== oldCover &&
      (await this.canPurgeCover(oldCover, teacherId, book.id))
    ) {
      await this.storageService.tryDelete(this.storageService.toKey(oldCover));
    }

    this.logger.log(`Book updated: ${id} by teacher ${teacherId}`);

    return await this.findOne(id);
  }

  /** Teacher image uploads are stored under `images/<teacherId>/`; that prefix is the ownership proof. */
  private ownedCoverPrefix(teacherId: string): string {
    return `images/${teacherId}/`;
  }

  private assertOwnedCoverReference(reference: string, teacherId: string): void {
    const key = this.storageService.toKey(reference);
    const prefix = this.ownedCoverPrefix(teacherId);
    if (
      !key.startsWith(prefix) ||
      key.length <= prefix.length ||
      key.includes('..') ||
      key.includes('\\') ||
      key.includes('?') ||
      key.includes('#')
    ) {
      throw new BadRequestException(
        biBody('Invalid cover image upload reference', 'مرجع صورة الغلاف غير صالح'),
      );
    }
  }

  /**
   * A stored cover may be deleted only when the teacher provably owns it, or when it is a legacy
   * un-owned upload that no other book references. A client-supplied reference alone never
   * authorises deleting a storage object.
   */
  private async canPurgeCover(
    reference: string,
    ownerId: string,
    bookId: string,
  ): Promise<boolean> {
    const key = this.storageService.toKey(reference);
    if (key.includes('..')) return false;
    if (key.startsWith(this.ownedCoverPrefix(ownerId))) return true;
    if (!/^images\/[^/]+$/u.test(key)) return false;
    const others = await this.booksRepository
      .createQueryBuilder('b')
      .where('b.id <> :bookId', { bookId })
      .andWhere('b.cover_image LIKE :like', { like: `%${key}` })
      .getCount();
    return others === 0;
  }

  private assertOwnedBookFileReference(reference: string, teacherId: string): void {
    const expectedPrefix = `books/${teacherId}/`;
    if (
      !reference.startsWith(expectedPrefix) ||
      reference.length <= expectedPrefix.length ||
      reference.includes('..') ||
      reference.includes('\\') ||
      reference.includes('?') ||
      reference.includes('#') ||
      /^https?:\/\//iu.test(reference) ||
      !reference.toLowerCase().endsWith('.pdf')
    ) {
      throw new BadRequestException(
        biBody('Invalid private book upload reference', 'Invalid private book upload reference'),
      );
    }
  }

  /**
   * Soft delete a book (teacher must own it)
   */
  public async delete(id: string, teacherId: string): Promise<void> {
    const book = await this.findOne(id);

    // Ownership validation
    if (book.teacher_id !== teacherId) {
      throw new ForbiddenException(
        biBody('You can only delete your own books', 'لا يمكنك حذف سوى كتبك الخاصة'),
      );
    }

    await this.booksRepository.softDelete(id);
    this.logger.log(`Book soft deleted: ${id} by teacher ${teacherId}`);
  }

  /**
   * Soft delete a book (admin only, ignores ownership). Purchase history is
   * untouched by a soft delete (the row and its `BookPurchase` FKs stay
   * intact), so unlike hardDelete there is no purchase-history guard here.
   */
  public async adminDelete(id: string): Promise<void> {
    const book = await this.booksRepository.findOne({
      where: { id, deleted_at: IsNull() },
    });

    if (!book) {
      throw new NotFoundException(
        biBody(`Book with ID ${id} not found`, `الكتاب بالمعرّف ${id} غير موجود`),
      );
    }

    await this.booksRepository.softDelete(id);
    this.logger.log(`Book soft deleted: ${id} by admin`);
  }

  /**
   * Hard delete a book (admin only)
   */
  public async hardDelete(id: string): Promise<void> {
    const book = await this.findOneAdmin(id);

    const hasPurchaseHistory = await this.bookPurchasesRepository.exist({
      where: { book_id: id },
    });
    if (hasPurchaseHistory) {
      throw new ConflictException(
        biBody(
          'A purchased book cannot be permanently deleted; archive it instead.',
          'لا يمكن حذف كتاب تم شراؤه نهائياً؛ قم بأرشفته بدلاً من ذلك.',
        ),
      );
    }

    await this.booksRepository.remove(book);

    // Permanent delete → purge the underlying storage objects (private PDF +
    // public cover) so nothing is left orphaned in R2.
    await this.storageService.tryDelete(this.storageService.toKey(book.book_file));
    if (
      book.cover_image != null &&
      book.cover_image !== '' &&
      (await this.canPurgeCover(book.cover_image, book.teacher_id, book.id))
    ) {
      await this.storageService.tryDelete(this.storageService.toKey(book.cover_image));
    }

    this.logger.log(`Book hard deleted: ${id}`);
  }

  /**
   * Restore a soft-deleted book (admin only)
   */
  public async restore(id: string): Promise<Book> {
    const book = await this.findOneAdmin(id);

    if (!book.deleted_at) {
      throw new ConflictException(biBody('Book is not deleted', 'الكتاب غير محذوف'));
    }

    await this.booksRepository.restore(id);
    this.logger.log(`Book restored: ${id}`);

    return await this.findOne(id);
  }

  /**
   * Increment purchase count
   */
  public async incrementPurchaseCount(bookId: string): Promise<void> {
    await this.booksRepository.increment({ id: bookId }, 'purchase_count', 1);
    this.logger.log(`Book purchase count incremented: ${bookId}`);
  }

  /**
   * Check if teacher owns the book
   */
  public async checkOwnership(bookId: string, teacherId: string): Promise<boolean> {
    const book = await this.findOne(bookId);
    return book.teacher_id === teacherId;
  }

  /**
   * Get all books for admin (including soft deleted)
   */
  public async findAllAdmin(filter: BookFilterDto): Promise<{
    data: Book[];
    meta: PaginationMeta;
  }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const skip = (page - 1) * limit;
    const sortBy = filter.sortBy ?? 'created_at';
    const order = filter.order ?? 'desc';

    const query = this.booksRepository
      .createQueryBuilder('book')
      .leftJoinAndSelect('book.teacher', 'teacher')
      .leftJoinAndSelect('book.subject', 'subject')
      .withDeleted();

    // Apply filters
    if (filter.search != null && filter.search !== '') {
      query.andWhere('(book.title ILIKE :search OR book.title_ar ILIKE :search)', {
        search: `%${filter.search}%`,
      });
    }

    if (filter.subject_id != null && filter.subject_id !== '') {
      query.andWhere('book.subject_id = :subjectId', {
        subjectId: filter.subject_id,
      });
    }

    if (filter.teacher_id != null && filter.teacher_id !== '') {
      query.andWhere('book.teacher_id = :teacherId', {
        teacherId: filter.teacher_id,
      });
    }

    // Apply sorting
    const sortOrder = order.toUpperCase() as 'ASC' | 'DESC';
    query.orderBy(`book.${sortBy}`, sortOrder).addOrderBy('book.id', sortOrder);

    // Get total count
    const total = await query.getCount();

    // Apply pagination
    query.skip(skip).take(limit);

    const books = await query.getMany();

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: books, meta };
  }
}
