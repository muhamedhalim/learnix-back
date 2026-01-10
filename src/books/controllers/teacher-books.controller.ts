import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
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
import { CreateBookDto, UpdateBookDto, BookFilterDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  async findMyBooks(
    @GetUser() user: JwtPayload,
    @Query() filter: Omit<BookFilterDto, 'teacher_id'>,
  ) {
    return this.booksService.findMyBooks(user.userId, filter);
  }

  /**
   * Create a new book
   */
  @Post()
  @ApiOperation({
    summary: 'Create a book',
    description: 'Creates a new book for the authenticated teacher.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Book created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Book with this title already exists',
  })
  async create(@GetUser() user: JwtPayload, @Body() dto: CreateBookDto) {
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
  @ApiOperation({
    summary: 'Get my book by ID',
    description: 'Returns a specific book owned by the authenticated teacher.',
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
  async findOne(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    // Validate teacher owns this book
    await this.booksService.checkOwnership(id, user.userId);

    const book = await this.booksService.findOne(id);
    const stats = await this.bookPurchasesService.getBookPurchaseStats(id);

    return {
      ...book,
      stats,
    };
  }

  /**
   * Update a book
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update my book',
    description: 'Updates a book owned by the authenticated teacher.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Book updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own books',
  })
  async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBookDto,
  ) {
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
  @ApiOperation({
    summary: 'Delete my book',
    description: 'Soft deletes a book owned by the authenticated teacher.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Book deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own books',
  })
  async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.booksService.delete(id, user.userId);
    return {
      message: 'Book deleted successfully',
    };
  }

  /**
   * Get my book revenue
   */
  @Get('revenue/summary')
  @ApiOperation({
    summary: 'Get my book revenue',
    description: "Returns the authenticated teacher's book revenue summary.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Revenue summary retrieved',
  })
  async getRevenue(@GetUser() user: JwtPayload) {
    return this.bookPurchasesService.getTeacherBookRevenue(user.userId);
  }
}
