import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { OptionalHybridAuthGuard } from '../auth/guards/optional-hybrid-auth.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { SearchQueryDto, SearchType, SuggestQueryDto } from './dto/search.dto';
import { SearchService } from './search.service';

@ApiTags('Search')
@Controller('search')
@UseGuards(OptionalHybridAuthGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Global search (grouped when type=all, else paginated)' })
  public async search(
    @Query() dto: SearchQueryDto,
    @GetUser() user: JwtPayload | undefined,
  ): Promise<unknown> {
    // Log the performed search (best-effort) for recent/popular suggestions.
    void this.searchService.logQuery(dto.q, user?.userId);

    if (!dto.type || dto.type === SearchType.ALL) {
      return this.searchService.searchAll(dto.q);
    }
    return this.searchService.searchByType(dto.q, dto.type, dto.page, dto.limit);
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Autocomplete suggestions (grouped, small)' })
  public async suggestions(@Query() dto: SuggestQueryDto): Promise<unknown> {
    return this.searchService.searchAll(dto.q);
  }

  @Get('in-course/:packageId')
  @ApiOperation({ summary: 'Search lessons + chapters within a course' })
  public async inCourse(
    @Param('packageId', ParseUUIDPipe) packageId: string,
    @Query('q') q: string,
  ): Promise<unknown> {
    return this.searchService.searchInCourse(packageId, q ?? '');
  }

  @Get('popular')
  @ApiOperation({ summary: 'Most popular recent searches (global)' })
  public async popular(
    @Query('limit', new DefaultValuePipe(8)) limit: number,
  ): Promise<{ data: unknown }> {
    const data = await this.searchService.getPopular(Number(limit) || 8);
    return { data };
  }

  @Get('recent')
  @ApiOperation({ summary: 'My recent searches (requires sign-in)' })
  public async recent(
    @GetUser() user: JwtPayload | undefined,
  ): Promise<{ data: string[] }> {
    if (!user) {
      throw new UnauthorizedException('Sign in to see recent searches');
    }
    const data = await this.searchService.getRecent(user.userId);
    return { data };
  }
}
