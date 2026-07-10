import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { TopWishlistedItemDto } from '../dto';
import { WishlistService } from '../wishlist.service';

@ApiTags('Admin · Wishlist')
@Controller('admin/wishlist')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminWishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get('analytics/top')
  @ApiOperation({ summary: 'Most-wishlisted items across all users' })
  public async top(
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<{ data: TopWishlistedItemDto[] }> {
    const data = await this.wishlistService.getTopWishlisted(limit);
    return { data };
  }
}
