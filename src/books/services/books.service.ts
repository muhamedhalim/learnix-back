import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { Subject } from '../../subjects/entities/subject.entity';
import { BookFilterDto, CreateBookDto, UpdateBookDto } from '../dto';
import { Book } from '../entities/book.entity';

@Injectable()
export class BooksService {
  private readonly logger = new Logger(BooksService.name);

  constructor(
    @InjectRepository(Book)
    private readonly booksRepository: Repository<Book>,
    @InjectRepository(Subject)
    private readonly subjectsRepository: Repository<Subject>,
  ) {}

  /**
   * Create a new book (teacher only)
   */
  public async create(teacherId: string, dto: CreateBookDto): Promise<Book> {
    // Validate subject exists
    const subject = await this.subjectsRepository.findOne({
      where: { id: dto.subject_id, deleted_at: IsNull() },
    });

    if (!subject) {
      throw new NotFoundException(
        `Subject with ID ${dto.subject_id} not found`,
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
      throw new ConflictException('You already have a book with this title');
    }

    const book = this.booksRepository.create(
      Object.assign({}, dto, { teacher_id: teacherId }),
    );

    const saved = await this.booksRepository.save(book);
    this.logger.log(`Book created: ${saved.id} by teacher ${teacherId}`);

    return await this.findOne(saved.id);
  }

  /**
   * Find all books (public, with filters)
   */
  public async findAll(filter: BookFilterDto): Promise<{
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
      query.andWhere(
        '(book.title ILIKE :search OR book.title_ar ILIKE :search)',
        { search: `%${filter.search}%` },
      );
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
    query.orderBy(`book.${sortBy}`, order.toUpperCase() as 'ASC' | 'DESC');

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
   * Find a single book by ID
   */
  public async findOne(id: string): Promise<Book> {
    const book = await this.booksRepository.findOne({
      where: { id, deleted_at: IsNull() },
      relations: ['teacher', 'subject'],
    });

    if (!book) {
      throw new NotFoundException(`Book with ID ${id} not found`);
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
      throw new NotFoundException(`Book with ID ${id} not found`);
    }

    return book;
  }

  /**
   * Update a book (teacher must own it)
   */
  public async update(
    id: string,
    teacherId: string,
    dto: UpdateBookDto,
  ): Promise<Book> {
    const book = await this.findOne(id);

    // Ownership validation
    if (book.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own books');
    }

    // If updating subject, validate it exists
    if (
      dto.subject_id != null &&
      dto.subject_id !== '' &&
      dto.subject_id !== book.subject_id
    ) {
      const subject = await this.subjectsRepository.findOne({
        where: { id: dto.subject_id, deleted_at: IsNull() },
      });

      if (!subject) {
        throw new NotFoundException(
          `Subject with ID ${dto.subject_id} not found`,
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
        throw new ConflictException('You already have a book with this title');
      }
    }

    Object.assign(book, dto);
    await this.booksRepository.save(book);

    this.logger.log(`Book updated: ${id} by teacher ${teacherId}`);

    return await this.findOne(id);
  }

  /**
   * Soft delete a book (teacher must own it)
   */
  public async delete(id: string, teacherId: string): Promise<void> {
    const book = await this.findOne(id);

    // Ownership validation
    if (book.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only delete your own books');
    }

    await this.booksRepository.softDelete(id);
    this.logger.log(`Book soft deleted: ${id} by teacher ${teacherId}`);
  }

  /**
   * Hard delete a book (admin only)
   */
  public async hardDelete(id: string): Promise<void> {
    const book = await this.findOneAdmin(id);
    await this.booksRepository.remove(book);
    this.logger.log(`Book hard deleted: ${id}`);
  }

  /**
   * Restore a soft-deleted book (admin only)
   */
  public async restore(id: string): Promise<Book> {
    const book = await this.findOneAdmin(id);

    if (!book.deleted_at) {
      throw new ConflictException('Book is not deleted');
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
  public async checkOwnership(
    bookId: string,
    teacherId: string,
  ): Promise<boolean> {
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
      query.andWhere(
        '(book.title ILIKE :search OR book.title_ar ILIKE :search)',
        { search: `%${filter.search}%` },
      );
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
    query.orderBy(`book.${sortBy}`, order.toUpperCase() as 'ASC' | 'DESC');

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
