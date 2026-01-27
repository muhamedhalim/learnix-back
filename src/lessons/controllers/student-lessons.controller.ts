import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LessonFilterDto } from '../dto';
import { LessonsService } from '../lessons.service';

@ApiTags('Student Lessons')
@Controller('student/lessons')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentLessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  /**
   * Browse available lessons
   * Returns lessons that the student can purchase
   */
  @Get()
  @ApiOperation({
    summary: 'Browse available lessons',
    description:
      'Returns a paginated list of available lessons for the student to purchase. Student only.',
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
    enum: ['price', 'title', 'created_at', 'students_count'],
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
    description: 'List of available lessons',
  })
  public async browseLessons(
    @Query() filter: LessonFilterDto,
  ): Promise<unknown> {
    return await this.lessonsService.findAll(filter);
  }

  /**
   * Get lesson details with access check
   * Returns lesson details and whether the student has access
   */
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Lesson not found',
  })
  public async getLessonWithAccess(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    const lesson = await this.lessonsService.findOne(id);
    const accessInfo = await this.lessonsService.validateAccess(id);

    return {
      lesson,
      access: accessInfo,
    };
  }
}
