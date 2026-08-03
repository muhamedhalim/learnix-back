import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { LimitQueryDto } from '../../common/dto/pagination.dto';
import { TopWishlistedItemDto } from '../dto';
import { WishlistService } from '../wishlist.service';

@ApiTags('Teacher Wishlist Analytics')
@Controller('teacher/wishlist')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherWishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get('analytics/top')
  @ApiOperation({ summary: 'Most-wishlisted content owned by the authenticated teacher' })
  public async top(
    @GetUser() user: JwtPayload,
    @Query() query: LimitQueryDto,
  ): Promise<{ data: TopWishlistedItemDto[] }> {
    return { data: await this.wishlistService.getTeacherTopWishlisted(user.userId, query.limit) };
  }
}
