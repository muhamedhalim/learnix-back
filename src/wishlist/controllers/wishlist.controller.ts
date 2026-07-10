import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  AddToWishlistDto,
  WishlistItemResponseDto,
  WishlistQueryDto,
  WishlistResponseDto,
} from '../dto';
import type { WishlistItemType } from '../entities/wishlist-item.entity';
import { WishlistService } from '../wishlist.service';

@ApiTags('Wishlist')
@Controller('wishlist')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Post('items')
  @ApiOperation({ summary: 'Add a lesson or package to the wishlist' })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Already wishlisted' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Item not found' })
  public async add(
    @GetUser() user: JwtPayload,
    @Body() dto: AddToWishlistDto,
  ): Promise<{ message: string; data: WishlistItemResponseDto }> {
    const data = await this.wishlistService.addToWishlist(user.userId, dto);
    return { message: 'Added to wishlist', data };
  }

  @Post('toggle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Toggle an item in the wishlist (add if absent, remove if present)',
  })
  public async toggle(
    @GetUser() user: JwtPayload,
    @Body() dto: AddToWishlistDto,
  ): Promise<{ wishlisted: boolean }> {
    return this.wishlistService.toggle(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get the current student wishlist' })
  @ApiResponse({ status: HttpStatus.OK, type: WishlistResponseDto })
  public async list(
    @GetUser() user: JwtPayload,
    @Query() query: WishlistQueryDto,
  ): Promise<WishlistResponseDto> {
    return this.wishlistService.getWishlist(user.userId, query);
  }

  @Get('count')
  @ApiOperation({ summary: 'Get the wishlist item count (badge)' })
  public async count(
    @GetUser() user: JwtPayload,
  ): Promise<{ count: number }> {
    const count = await this.wishlistService.getCount(user.userId);
    return { count };
  }

  @Get('refs')
  @ApiOperation({
    summary: 'Get wishlisted (itemType, itemId) refs for heart-state hydration',
  })
  public async refs(
    @GetUser() user: JwtPayload,
  ): Promise<{ data: { itemType: WishlistItemType; itemId: string }[] }> {
    const data = await this.wishlistService.getWishlistedRefs(user.userId);
    return { data };
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove an item from the wishlist' })
  @ApiParam({ name: 'itemId', description: 'Wishlist entry ID' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Item not found' })
  public async remove(
    @GetUser() user: JwtPayload,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<{ message: string }> {
    await this.wishlistService.removeItem(user.userId, itemId);
    return { message: 'Removed from wishlist' };
  }

  @Post('items/:itemId/move-to-cart')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Move a wishlisted item into the cart' })
  @ApiParam({ name: 'itemId', description: 'Wishlist entry ID' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Item not found' })
  public async moveToCart(
    @GetUser() user: JwtPayload,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<{ message: string }> {
    await this.wishlistService.moveToCart(user.userId, itemId);
    return { message: 'Moved to cart' };
  }
}
