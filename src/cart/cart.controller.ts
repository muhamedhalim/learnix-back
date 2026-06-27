import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { CartService } from './cart.service';
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
  @Post('items')
  @ApiOperation({ summary: 'Add lesson or package to cart' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson or package not found',
  })
  public async addToCart(
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
  @ApiOperation({ summary: 'Get current student cart' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Cart retrieved successfully',
    type: CartResponseDto,
  })
  public async getCart(
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
    status: HttpStatus.NOT_FOUND,
    description: 'Cart or item not found',
  })
  public async removeItem(
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
  @ApiOperation({ summary: 'Process cart checkout and payment' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cart is empty or invalid payment method',
  })
  public async checkout(
    @GetUser() user: JwtPayload,
    @Body() dto: CheckoutCartDto,
  ): Promise<{ message: string; data: unknown }> {
    return await this.cartService.checkout(user.userId, dto);
  }
}
