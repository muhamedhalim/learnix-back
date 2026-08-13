import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { OptionalHybridAuthGuard } from '../auth/guards/optional-hybrid-auth.guard';
import { THROTTLE } from '../common/constants';
import { GetUser } from '../common/decorators/get-user.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { UserRole } from '../users/entities/user-role.enum';
import {
  performanceMetrics,
  type SearchMetricActor,
  type SearchMetricOutcome,
  type SearchMetricSurface,
} from '../observability/performance-metrics.registry';
import { InCourseSearchDto, SearchQueryDto, SearchType, SuggestQueryDto } from './dto/search.dto';
import { SearchService } from './search.service';
import { biBody } from '../i18n/error-translator.util';

@ApiTags('Search')
@Controller('search')
@UseGuards(OptionalHybridAuthGuard)
@Throttle({ default: THROTTLE.SEARCH })
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Global search (grouped when type=all, else paginated)' })
  public async search(
    @Query() dto: SearchQueryDto,
    @GetUser() user: JwtPayload | undefined,
  ): Promise<unknown> {
    const startedAt = performance.now();
    const type = dto.type ?? SearchType.ALL;
    // Search terms can contain personal or operational data. Only retain them
    // for the authenticated caller's private recent-search history.
    if (user && user.role !== UserRole.CALL_CENTER) {
      void this.searchService.logQuery(dto.q, user.userId);
    }

    try {
      const result =
        !dto.type || dto.type === SearchType.ALL
          ? await this.searchService.searchAll(dto.q, user)
          : await this.searchService.searchByType(dto.q, dto.type, dto.page, dto.limit, user);
      this.recordSearch('query', type, user, result, startedAt);
      return result;
    } catch (error) {
      this.recordSearch('query', type, user, undefined, startedAt, 'error');
      throw error;
    }
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Autocomplete suggestions (grouped, small)' })
  public async suggestions(
    @Query() dto: SuggestQueryDto,
    @GetUser() user: JwtPayload | undefined,
  ): Promise<unknown> {
    const startedAt = performance.now();
    try {
      const result = await this.searchService.searchAll(dto.q, user);
      this.recordSearch('suggestions', SearchType.ALL, user, result, startedAt);
      return result;
    } catch (error) {
      this.recordSearch('suggestions', SearchType.ALL, user, undefined, startedAt, 'error');
      throw error;
    }
  }

  @Get('in-course/:packageId')
  @ApiOperation({ summary: 'Search lessons + chapters within a course' })
  public async inCourse(
    @Param('packageId', ParseUUIDPipe) packageId: string,
    @Query() dto: InCourseSearchDto,
    @GetUser() user: JwtPayload | undefined,
  ): Promise<unknown> {
    const startedAt = performance.now();
    try {
      const result = await this.searchService.searchInCourse(packageId, dto.q ?? '');
      this.recordSearch('in_course', 'curriculum', user, result, startedAt);
      return result;
    } catch (error) {
      this.recordSearch('in_course', 'curriculum', user, undefined, startedAt, 'error');
      throw error;
    }
  }

  @Get('recent')
  @ApiOperation({ summary: 'My recent searches (requires sign-in)' })
  public async recent(@GetUser() user: JwtPayload | undefined): Promise<{ data: string[] }> {
    if (!user) {
      throw new UnauthorizedException(
        biBody('Sign in to see recent searches', 'يرجى تسجيل الدخول لعرض عمليات البحث الأخيرة'),
      );
    }
    const data = await this.searchService.getRecent(user.userId);
    return { data };
  }

  private recordSearch(
    surface: SearchMetricSurface,
    type: string,
    user: JwtPayload | undefined,
    result: unknown,
    startedAt: number,
    forcedOutcome?: SearchMetricOutcome,
  ): void {
    const resultCount = this.resultCount(result);
    performanceMetrics.recordSearch({
      surface,
      type,
      actor: this.searchActor(user),
      outcome: forcedOutcome ?? (resultCount === 0 ? 'empty' : 'success'),
      durationMs: performance.now() - startedAt,
      resultCount,
    });
  }

  private searchActor(user: JwtPayload | undefined): SearchMetricActor {
    switch (user?.role) {
      case UserRole.ADMIN:
      case UserRole.CALL_CENTER:
      case UserRole.TEACHER:
      case UserRole.STUDENT:
        return user.role;
      default:
        return 'anonymous';
    }
  }

  /** Counts only known result arrays; search text and result values never enter telemetry. */
  private resultCount(result: unknown): number {
    if (result === null || typeof result !== 'object') return 0;
    const record = result as Record<string, unknown>;
    if (Array.isArray(record['data'])) return record['data'].length;
    return [
      'courses',
      'lessons',
      'books',
      'teachers',
      'subjects',
      'supportUsers',
      'chapters',
    ].reduce((count, key) => count + (Array.isArray(record[key]) ? record[key].length : 0), 0);
  }
}
