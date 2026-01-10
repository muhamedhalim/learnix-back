import {
  Controller,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { BooksService } from '../services/books.service';
import { BookFilterDto } from '../dto';

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
  async findAll(@Query() filter: BookFilterDto) {
    return this.booksService.findAll(filter);
  }

  /**
   * Get a single book by ID (public)
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get book by ID',
    description: 'Returns a specific book by its ID. Public endpoint.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Book retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.booksService.findOne(id);
  }
}
