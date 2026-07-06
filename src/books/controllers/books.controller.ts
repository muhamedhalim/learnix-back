import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { BookFilterDto } from '../dto';
import { Book } from '../entities/book.entity';
import { BooksService } from '../services/books.service';

/** Public-facing book shape — omits `book_file`, the private R2 storage key,
 * which has no use outside purchase-gated download and must never leak to an
 * unauthenticated/public response. */
type PublicBook = Omit<Book, 'book_file'>;

function toPublicBook(book: Book): PublicBook {
  const { book_file: _book_file, ...rest } = book;
  return rest;
}

@ApiTags('Books')
@Controller('books')
export class BooksController {
  constructor(private readonly booksService: BooksService) {}

  /**
   * Get all books (public)
   */
  @Get()
  @ApiOperation({
    summary: 'Get all books',
    description:
      'Returns a paginated list of all available books. Public endpoint.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by title',
  })
  @ApiQuery({
    name: 'subject_id',
    required: false,
    type: Number,
    description: 'Filter by subject ID',
  })
  @ApiQuery({
    name: 'teacher_id',
    required: false,
    type: Number,
    description: 'Filter by teacher ID',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['price', 'title', 'created_at', 'purchase_count'],
    description: 'Sort by field (default: created_at)',
  })
  @ApiQuery({
    name: 'order',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort order (default: desc)',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 20)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of books with pagination',
  })
  public async findAll(@Query() filter: BookFilterDto): Promise<unknown> {
    const result = await this.booksService.findAll(filter);
    return { ...result, data: result.data.map(toPublicBook) };
  }

  /**
   * Get a single book by ID (public)
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const book = await this.booksService.findOne(id);
    return toPublicBook(book);
  }
}
