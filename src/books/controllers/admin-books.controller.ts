import {
  Controller,
  Get,
  Delete,
  Post,
  Param,
  Query,
  ParseIntPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { BooksService } from '../services/books.service';
import { BookPurchasesService } from '../services/book-purchases.service';
import { BookFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

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
  async findAll(@Query() filter: BookFilterDto) {
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
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Book retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const book = await this.booksService.findOneAdmin(id);
    const stats = await this.bookPurchasesService.getBookPurchaseStats(id);

    return {
      ...book,
      stats,
    };
  }

  /**
   * Hard delete a book
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Hard delete a book',
    description: 'Permanently deletes a book. Admin only. Cannot be undone.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Book permanently deleted',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  async hardDelete(@Param('id', ParseIntPipe) id: number) {
    await this.booksService.hardDelete(id);
    return {
      message: 'Book permanently deleted',
    };
  }

  /**
   * Restore a soft-deleted book
   */
  @Post(':id/restore')
  @ApiOperation({
    summary: 'Restore a deleted book',
    description: 'Restores a soft-deleted book. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Book restored successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Book is not deleted',
  })
  async restore(@Param('id', ParseIntPipe) id: number) {
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
  async getAllPurchases(@Query() filter: BookFilterDto) {
    return this.bookPurchasesService.getAllPurchases(filter);
  }
}
