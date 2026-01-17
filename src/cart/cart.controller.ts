import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CartService } from './cart.service';
import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GetUser } from '../common/decorators/get-user.decorator';
import { JwtPayload } from '../common/interfaces/user-request.interface';
import { AddToCartDto, CartResponseDto, CheckoutCartDto } from './dto';

@ApiTags('Cart')
@Controller('cart')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  /**
   * Add item to cart (student only)
   */
  @Post('add')
  @ApiOperation({
    summary: 'Add item to cart',
    description:
      "Adds a lesson or package to the shopping cart. Creates cart if it doesn't exist. Prevents duplicate items.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Item added to cart successfully',
    type: CartResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Item already in cart',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson or package not found',
  })
  async addToCart(
    @GetUser() user: JwtPayload,
    @Body() dto: AddToCartDto,
  ): Promise<{ message: string; data: CartResponseDto }> {
    const cart = await this.cartService.addToCart(user.userId, dto);
    return {
      message: 'Item added to cart',
      data: cart,
    };
  }

  /**
   * Get cart (student only)
   */
  @Get()
  @ApiOperation({
    summary: 'Get shopping cart',
    description:
      "Returns the current user's cart with all items, subtotal, discount, and total. Returns empty cart if none exists.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Cart retrieved successfully',
    type: CartResponseDto,
  })
  async getCart(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: CartResponseDto }> {
    const cart = await this.cartService.findCart(user.userId);
    return { data: cart };
  }

  /**
   * Remove item from cart (student only)
   */
  @Delete('items/:itemId')
  @ApiOperation({
    summary: 'Remove item from cart',
    description:
      'Removes a specific item from the shopping cart by cart item ID.',
  })
  @ApiParam({
    name: 'itemId',
    description: 'Cart item ID (not lesson/package ID)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Item removed from cart',
    type: CartResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Cart or item not found',
  })
  async removeItem(
    @GetUser() user: JwtPayload,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<{ message: string; data: CartResponseDto }> {
    const cart = await this.cartService.removeItem(user.userId, itemId);
    return {
      message: 'Item removed from cart',
      data: cart,
    };
  }

  /**
   * Checkout cart (student only)
   */
  @Post('checkout')
  @ApiOperation({
    summary: 'Checkout cart',
    description:
      'Processes cart checkout with selected payment method. Paymob returns payment URL, attendance code grants immediate access and clears cart.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Checkout initiated or completed',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cart is empty or invalid payment method',
  })
  async checkout(
    @GetUser() user: JwtPayload,
    @Body() dto: CheckoutCartDto,
  ): Promise<{ message: string; data: unknown }> {
    return this.cartService.checkout(user.userId, dto);
  }
}
