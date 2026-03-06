import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { BookFilterDto, CreateBookDto, UpdateBookDto } from '../dto';
import { BookPurchasesService } from '../services/book-purchases.service';
import { BooksService } from '../services/books.service';

@ApiTags('Teacher Books')
@Controller('teacher/books')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherBooksController {
  constructor(
    private readonly booksService: BooksService,
    private readonly bookPurchasesService: BookPurchasesService,
  ) {}

  /**
   * Get my books
   */
  @Get()
  @ApiOperation({
    summary: 'Get my books',
    description:
      "Returns a paginated list of the authenticated teacher's books.",
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
    description: "List of teacher's books",
  })
  public async findMyBooks(
    @GetUser() user: JwtPayload,
    @Query() filter: Omit<BookFilterDto, 'teacher_id'>,
  ): Promise<unknown> {
    return await this.booksService.findMyBooks(user.userId, filter);
  }

  /**
   * Create a new book
   */
  @Post()
  @ApiOperation({ summary: 'Create a new book' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Book created successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Book with this title already exists',
  })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() dto: CreateBookDto,
  ): Promise<{ message: string; data: unknown }> {
    const book = await this.booksService.create(user.userId, dto);
    return {
      message: 'Book created successfully',
      data: book,
    };
  }

  /**
   * Get a single book by ID (must be owner)
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get book details (owner only)' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  public async findOne(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    // Validate teacher owns this book
    await this.booksService.checkOwnership(id, user.userId);

    const book = await this.booksService.findOne(id);
    const stats = await this.bookPurchasesService.getBookPurchaseStats(id);

    return {
      book,
      stats,
    };
  }

  /**
   * Update a book
   */
  @Put(':id')
  @ApiOperation({ summary: 'Update a book' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own books',
  })
  public async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBookDto,
  ): Promise<{ message: string; data: unknown }> {
    const book = await this.booksService.update(id, user.userId, dto);
    return {
      message: 'Book updated successfully',
      data: book,
    };
  }

  /**
   * Delete a book (soft delete)
   */
  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a book' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own books',
  })
  public async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    await this.booksService.delete(id, user.userId);
    return {
      message: 'Book deleted successfully',
    };
  }

  /**
   * Get my book revenue
   */
  @Get('revenue')
  @ApiOperation({ summary: 'Get total revenue from books' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue summary retrieved',
  })
  public async getRevenue(@GetUser() user: JwtPayload): Promise<unknown> {
    return await this.bookPurchasesService.getTeacherBookRevenue(user.userId);
  }
}
