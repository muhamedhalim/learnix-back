import {
  Controller,
  Get,
  Param,
  Query,
  ParseUUIDPipe,
  ParseIntPipe,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { SubjectsService } from '../subjects.service';
import { SubjectFilterDto } from '../dto';

@ApiTags('Subjects')
@Controller('subjects')
export class SubjectsController {
  constructor(private readonly subjectsService: SubjectsService) {}

  /**
   * Get all subjects with pagination and optional search
   * Public endpoint - no authentication required
   */
  @Get()
  @ApiOperation({
    summary: 'Get all subjects',
    description:
      'Returns a paginated list of subjects with optional search filter',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Search by title' })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page',
    example: 20,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of subjects retrieved successfully',
  })
  async findAll(@Query() filter: SubjectFilterDto) {
    return this.subjectsService.findAll(filter);
  }

  /**
   * Get a single subject by ID
   * Public endpoint - no authentication required
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get subject by ID',
    description: 'Returns a single subject with its details',
  })
  @ApiParam({ name: 'id', description: 'Subject ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subject retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.subjectsService.findOne(id);
  }

  /**
   * Get teachers who teach a specific subject
   * Public endpoint - no authentication required
   */
  @Get(':id/teachers')
  @ApiOperation({
    summary: 'Get teachers by subject',
    description: 'Returns teachers who teach this subject with their stats',
  })
  @ApiParam({ name: 'id', description: 'Subject ID' })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number',
    example: 1,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page',
    example: 20,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teachers list retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  async findTeachersBySubject(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new ParseIntPipe({ optional: true })) page: number = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit: number = 20,
  ) {
    return this.subjectsService.findTeachersBySubject(id, page, limit);
  }
}
