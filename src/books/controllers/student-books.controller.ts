import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { Response } from 'express';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { MediaService } from '../../media/media.service';
import { BookFilterDto, PurchaseBookDto, toPublicBookResponse } from '../dto';
import { BookPurchasesService } from '../services/book-purchases.service';
import { BooksService } from '../services/books.service';

@ApiTags('Student Books')
@Controller('student/books')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentBooksController {
  constructor(
    private readonly bookPurchasesService: BookPurchasesService,
    private readonly booksService: BooksService,
    private readonly media: MediaService,
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
  public async getMyBooks(
    @GetUser() user: JwtPayload,
    @Query() filter: BookFilterDto,
  ): Promise<unknown> {
    const result = await this.bookPurchasesService.getMyBooks(user.userId, filter);
    return {
      data: result.data.map((purchase) => ({
        id: purchase.id,
        student_id: purchase.student_id,
        book_id: purchase.book_id,
        payment_id: purchase.payment_id,
        price_paid: Number(purchase.price_paid),
        purchased_at: purchase.purchased_at,
        book: toPublicBookResponse(purchase.book, (value) =>
          this.media.resolveThumbnailUrl(value),
        ),
      })),
      meta: result.meta,
    };
  }

  /**
   * Check if book is purchased
   */
  @Get(':id/access')
  @ApiOperation({ summary: 'Check if current student has access to a book' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Access status returned',
  })
  public async checkAccess(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) bookId: string,
  ): Promise<{ has_access: boolean; purchased_at: Date | null }> {
    const purchase = await this.bookPurchasesService.checkAlreadyPurchased(
      user.userId,
      bookId,
    );

    return {
      has_access: !!purchase,
      purchased_at: purchase?.purchased_at ?? null,
    };
  }

  /**
   * Stream a purchased book through an authenticated route.
   */
  @Get(':id/download/file')
  @ApiOperation({ summary: 'Download a purchased book through the protected backend route' })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Book was not purchased by the current student',
  })
  public async downloadFile(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) bookId: string,
    @Res() res: Response,
  ): Promise<void> {
    const { object, book } = await this.bookPurchasesService.getDownloadObject(
      user.userId,
      bookId,
    );
    const safeTitle = book.title.replace(/[^\w.-]+/g, '_') || 'book';

    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    if (object.contentLength !== undefined) {
      res.setHeader('Content-Length', object.contentLength.toString());
    }

    object.stream.on('error', () => {
      res.destroy();
    });
    object.stream.pipe(res);
  }

  /**
   * Get download URL for a purchased book
   */
  @Get(':id/download')
  @ApiOperation({ summary: 'Get secure download URL for a purchased book' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  public async getDownloadUrl(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) bookId: string,
  ): Promise<unknown> {
    const result = await this.bookPurchasesService.getDownloadUrl(
      user.userId,
      bookId,
    );

    return {
      message: 'Download URL retrieved successfully',
      download_url: result.download_url,
      book: toPublicBookResponse(result.book, (value) =>
        this.media.resolveThumbnailUrl(value),
      ),
    };
  }

  /**
   * Purchase a book
   * Note: This endpoint initiates the purchase flow.
   * For full payment integration, it should redirect to PaymentsService.
   */
  @Post('purchase')
  @ApiOperation({ summary: 'Initiate book purchase' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Book not found',
  })
  public async purchaseBook(
    @GetUser() user: JwtPayload,
    @Body() dto: PurchaseBookDto,
  ): Promise<unknown> {
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
      discount_code: dto.discount_code ?? null,
      purchase_code: dto.purchase_code ?? null,
      redirect_to_payment: true,
    };
  }
}
