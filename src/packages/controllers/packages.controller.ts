import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { PlaybackCookiesInterceptor } from '../../video/playback-cookies';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { PackageFilterDto, TeacherPackageFilterDto } from '../dto';
import { CourseStatus } from '../entities/course-status.enum';
import { CoursePreviewService } from '../course-preview.service';
import { PackagesService } from '../packages.service';

@ApiTags('Packages')
@Controller('packages')
export class PackagesController {
  constructor(
    private readonly packagesService: PackagesService,
    private readonly coursePreviewService: CoursePreviewService,
  ) {}

  /**
   * List all active packages
   * Public endpoint for browsing available packages
   */
  @Get()
  @ApiOperation({
    summary: 'List all packages',
    description: 'Returns a paginated list of active lesson packages.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by title',
  })
  @ApiQuery({
    name: 'teacher_id',
    required: false,
    type: Number,
    description: 'Filter by teacher ID',
  })
  @ApiQuery({
    name: 'minPrice',
    required: false,
    type: Number,
    description: 'Minimum price filter',
  })
  @ApiQuery({
    name: 'maxPrice',
    required: false,
    type: Number,
    description: 'Maximum price filter',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['price', 'title', 'created_at', 'lessons_count'],
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
    description: 'List of packages',
  })
  public async findAll(@Query() filter: PackageFilterDto): Promise<{
    data: unknown[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  }> {
    // Public catalogue: only PUBLISHED, active courses. Forced values are
    // applied last so a client cannot override them via query params.
    const publicFilter = Object.assign({}, filter, {
      is_active: true,
      status: CourseStatus.PUBLISHED,
    });
    return await this.packagesService.findAllPublic(publicFilter);
  }

  /**
   * Cookie grant for a free-preview lesson hosted on AWS. Never cached: the response sets
   * path-scoped, short-lived signed cookies.
   */
  @Get(':id/preview/lessons/:lessonId/playback')
  @UseInterceptors(PlaybackCookiesInterceptor)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Playback grant for a free-preview lesson (AWS video)' })
  public async previewPlayback(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lessonId', ParseUUIDPipe) lessonId: string,
  ): Promise<unknown> {
    return await this.coursePreviewService.getPreviewPlayback(id, lessonId);
  }

  /**
   * Public pre-purchase course preview: curriculum (locked/free lessons),
   * instructor, rating, students count, requirements, FAQ, related courses.
   */
  @Get(':id/preview')
  @ApiOperation({
    summary: 'Public course preview',
    description:
      'Everything a visitor needs before buying: curriculum with locked/free ' +
      'lessons, instructor profile, rating, students count, and related courses.',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Course not found' })
  public async preview(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.coursePreviewService.getPreview(id);
  }

  /**
   * Get a single package by ID
   */
  @Get(':id')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.packagesService.findPublicOne(id);
  }

  /**
   * Get packages by teacher
   */
  @Get('teacher/:teacherId')
  @ApiOperation({
    summary: 'Get packages by teacher',
    description: 'Returns all active packages created by a specific teacher.',
  })
  @ApiParam({ name: 'teacherId', description: 'Teacher ID' })
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
    description: 'List of packages by teacher',
  })
  public async findByTeacher(
    @Param('teacherId', ParseUUIDPipe) teacherId: string,
    @Query() filter: TeacherPackageFilterDto,
  ): Promise<{
    data: unknown[];
    meta: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  }> {
    // Public teacher storefront: only their PUBLISHED, active courses.
    return await this.packagesService.findByTeacherPublic(teacherId, {
      ...filter,
      is_active: true,
      status: CourseStatus.PUBLISHED,
    });
  }
}
