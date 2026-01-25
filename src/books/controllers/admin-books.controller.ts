import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { BookFilterDto } from '../dto';
import { BookPurchasesService } from '../services/book-purchases.service';
import { BooksService } from '../services/books.service';

@ApiTags('Admin Books')
@Controller('admin/books')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminBooksController {
  constructor(
    private readonly booksService: BooksService,
    private readonly bookPurchasesService: BookPurchasesService,
  ) {}

  /**
   * Get all books (including soft deleted)
   */
  @Get()
  @ApiOperation({
    summary: 'Get all books (admin)',
    description: 'Returns all books including soft-deleted ones. Admin only.',
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
    description: 'List of all books',
  })
  public async findAll(@Query() filter: BookFilterDto): Promise<unknown> {
    return this.booksService.findAllAdmin(filter);
  }

  /**
   * Get a single book by ID (including soft deleted)
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get book by ID (admin)',
    description:
      'Returns a specific book including if soft-deleted. Admin only.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  public async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    const book = await this.booksService.findOneAdmin(id);
    const stats = await this.bookPurchasesService.getBookPurchaseStats(id);

    return {
      book,
      stats,
    };
  }

  /**
   * Hard delete a book
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  public async hardDelete(@Param('id', ParseUUIDPipe) id: string): Promise<{ message: string }> {
    await this.booksService.hardDelete(id);
    return {
      message: 'Book permanently deleted',
    };
  }

  /**
   * Restore a soft-deleted book
   */
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Book is not deleted',
  })
  public async restore(@Param('id', ParseUUIDPipe) id: string): Promise<{ message: string; data: unknown }> {
    const book = await this.booksService.restore(id);
    return {
      message: 'Book restored successfully',
      data: book,
    };
  }

  /**
   * Get all book purchases
   */
  @Get('purchases/all')
  @ApiOperation({
    summary: 'Get all book purchases',
    description: 'Returns all book purchases. Admin only.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by book title',
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
    description: 'List of all book purchases',
  })
  public async getAllPurchases(@Query() filter: BookFilterDto): Promise<unknown> {
    return this.bookPurchasesService.getAllPurchases(filter);
  }
}
