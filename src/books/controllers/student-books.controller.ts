import {
  Controller,
  Get,
  Post,
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
import { BookPurchasesService } from '../services/book-purchases.service';
import { BooksService } from '../services/books.service';
import { BookFilterDto, PurchaseBookDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

@ApiTags('Student Books')
@Controller('student/books')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentBooksController {
  constructor(
    private readonly bookPurchasesService: BookPurchasesService,
    private readonly booksService: BooksService,
  ) {}

  /**
   * Get my purchased books
   */
  @Get()
  @ApiOperation({
    summary: 'Get my purchased books',
    description:
      "Returns a paginated list of the authenticated student's purchased books.",
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
    description: 'List of purchased books',
  })
  async getMyBooks(
    @GetUser() user: JwtPayload,
    @Query() filter: BookFilterDto,
  ) {
    return this.bookPurchasesService.getMyBooks(user.userId, filter);
  }

  /**
   * Check if book is purchased
   */
  @Get(':id/access')
  @ApiOperation({
    summary: 'Check book access',
    description: 'Check if the student has purchased a specific book.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Access status returned',
  })
  async checkAccess(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) bookId: number,
  ) {
    const purchase = await this.bookPurchasesService.checkAlreadyPurchased(
      user.userId,
      bookId,
    );

    return {
      has_access: !!purchase,
      purchased_at: purchase?.purchased_at || null,
    };
  }

  /**
   * Get download URL for a purchased book
   */
  @Get(':id/download')
  @ApiOperation({
    summary: 'Get book download URL',
    description:
      'Returns the download URL for a purchased book. Student must have purchased the book.',
  })
  @ApiParam({ name: 'id', description: 'Book ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Download URL returned',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You have not purchased this book',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  async getDownloadUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) bookId: number,
  ) {
    const result = await this.bookPurchasesService.getDownloadUrl(
      user.userId,
      bookId,
    );

    return {
      message: 'Download URL retrieved successfully',
      ...result,
    };
  }

  /**
   * Purchase a book
   * Note: This endpoint initiates the purchase flow.
   * For full payment integration, it should redirect to PaymentsService.
   */
  @Post('purchase')
  @ApiOperation({
    summary: 'Purchase a book',
    description:
      'Initiates the purchase process for a book. Supports discount codes.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Purchase initiated',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Book already purchased',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  async purchaseBook(
    @GetUser() user: JwtPayload,
    @Body() dto: PurchaseBookDto,
  ) {
    // Check if already purchased
    const existing = await this.bookPurchasesService.checkAlreadyPurchased(
      user.userId,
      dto.book_id,
    );

    if (existing) {
      return {
        message: 'You have already purchased this book',
        already_purchased: true,
        purchase: existing,
      };
    }

    // Get book to check price
    const book = await this.booksService.findOne(dto.book_id);

    // For now, return the book info and price
    // Full payment integration would call PaymentsService here
    return {
      message: 'Book ready for purchase',
      book: {
        id: book.id,
        title: book.title,
        title_ar: book.title_ar,
        price: book.price,
      },
      discount_code: dto.discount_code || null,
      purchase_code: dto.purchase_code || null,
      redirect_to_payment: true,
    };
  }
}
