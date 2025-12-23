import {
  Controller,
  Get,
  Param,
  Query,
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
import { PackagesService } from '../packages.service';
import { PackageFilterDto } from '../dto';

@ApiTags('Packages')
@Controller('packages')
export class PackagesController {
  constructor(private readonly packagesService: PackagesService) {}

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
  async findAll(@Query() filter: PackageFilterDto) {
    return this.packagesService.findAll({ ...filter, is_active: true });
  }

  /**
   * Get a single package by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get package by ID',
    description:
      'Returns detailed information about a package including lessons.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package details retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.packagesService.findOne(id);
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
  async findByTeacher(
    @Param('teacherId', ParseIntPipe) teacherId: number,
    @Query() filter: Omit<PackageFilterDto, 'teacher_id'>,
  ) {
    return this.packagesService.findByTeacher(teacherId, {
      ...filter,
      is_active: true,
    });
  }
}
