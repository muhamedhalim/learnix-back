import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Book } from '../entities/book.entity';
import { CreateBookDto, UpdateBookDto, BookFilterDto } from '../dto';
import { Subject } from '../../subjects/entities/subject.entity';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';

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
  async create(teacherId: number, dto: CreateBookDto): Promise<Book> {
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

    const book = this.booksRepository.create({
      ...dto,
      teacher_id: teacherId,
    });

    const saved = await this.booksRepository.save(book);
    this.logger.log(`Book created: ${saved.id} by teacher ${teacherId}`);

    return this.findOne(saved.id);
  }

  /**
   * Find all books (public, with filters)
   */
  async findAll(filter: BookFilterDto): Promise<{
    data: Book[];
    meta: PaginationMeta;
  }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;
    const sortBy = filter.sortBy || 'created_at';
    const order = filter.order || 'desc';

    const query = this.booksRepository
      .createQueryBuilder('book')
      .leftJoinAndSelect('book.teacher', 'teacher')
      .leftJoinAndSelect('book.subject', 'subject')
      .where('book.deleted_at IS NULL');

    // Apply filters
    if (filter.search) {
      query.andWhere(
        '(book.title ILIKE :search OR book.title_ar ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    if (filter.subject_id) {
      query.andWhere('book.subject_id = :subjectId', {
        subjectId: filter.subject_id,
      });
    }

    if (filter.teacher_id) {
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
  async findMyBooks(
    teacherId: number,
    filter: Omit<BookFilterDto, 'teacher_id'>,
  ): Promise<{ data: Book[]; meta: PaginationMeta }> {
    return this.findAll({ ...filter, teacher_id: teacherId });
  }

  /**
   * Find a single book by ID
   */
  async findOne(id: number): Promise<Book> {
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
  async findOneAdmin(id: number): Promise<Book> {
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
  async update(
    id: number,
    teacherId: number,
    dto: UpdateBookDto,
  ): Promise<Book> {
    const book = await this.findOne(id);

    // Ownership validation
    if (book.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only update your own books');
    }

    // If updating subject, validate it exists
    if (dto.subject_id && dto.subject_id !== book.subject_id) {
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
    if (dto.title && dto.title !== book.title) {
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

    return this.findOne(id);
  }

  /**
   * Soft delete a book (teacher must own it)
   */
  async delete(id: number, teacherId: number): Promise<void> {
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
  async hardDelete(id: number): Promise<void> {
    const book = await this.findOneAdmin(id);
    await this.booksRepository.remove(book);
    this.logger.log(`Book hard deleted: ${id}`);
  }

  /**
   * Restore a soft-deleted book (admin only)
   */
  async restore(id: number): Promise<Book> {
    const book = await this.findOneAdmin(id);

    if (!book.deleted_at) {
      throw new ConflictException('Book is not deleted');
    }

    await this.booksRepository.restore(id);
    this.logger.log(`Book restored: ${id}`);

    return this.findOne(id);
  }

  /**
   * Increment purchase count
   */
  async incrementPurchaseCount(bookId: number): Promise<void> {
    await this.booksRepository.increment({ id: bookId }, 'purchase_count', 1);
    this.logger.log(`Book purchase count incremented: ${bookId}`);
  }

  /**
   * Check if teacher owns the book
   */
  async checkOwnership(bookId: number, teacherId: number): Promise<boolean> {
    const book = await this.findOne(bookId);
    return book.teacher_id === teacherId;
  }

  /**
   * Get all books for admin (including soft deleted)
   */
  async findAllAdmin(filter: BookFilterDto): Promise<{
    data: Book[];
    meta: PaginationMeta;
  }> {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;
    const sortBy = filter.sortBy || 'created_at';
    const order = filter.order || 'desc';

    const query = this.booksRepository
      .createQueryBuilder('book')
      .leftJoinAndSelect('book.teacher', 'teacher')
      .leftJoinAndSelect('book.subject', 'subject')
      .withDeleted();

    // Apply filters
    if (filter.search) {
      query.andWhere(
        '(book.title ILIKE :search OR book.title_ar ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    if (filter.subject_id) {
      query.andWhere('book.subject_id = :subjectId', {
        subjectId: filter.subject_id,
      });
    }

    if (filter.teacher_id) {
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
