import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PackagesService } from '../packages.service';
import {
  CreatePackageDto,
  UpdatePackageDto,
  AddLessonsDto,
  RemoveLessonsDto,
  PackageFilterDto,
} from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

@ApiTags('Teacher Packages')
@Controller('teacher/packages')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherPackagesController {
  constructor(private readonly packagesService: PackagesService) {}

  /**
   * Get my packages
   * Returns the authenticated teacher's packages
   */
  @Get()
  @ApiOperation({
    summary: 'Get my packages',
    description:
      "Returns a paginated list of the authenticated teacher's packages. Teacher only.",
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Search by title',
  })
  @ApiQuery({
    name: 'is_active',
    required: false,
    type: Boolean,
    description: 'Filter by active status',
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
    description: "List of teacher's packages",
  })
  async findMyPackages(
    @GetUser() user: JwtPayload,
    @Query() filter: Omit<PackageFilterDto, 'teacher_id'>,
  ) {
    return this.packagesService.findMyPackages(user.userId, filter);
  }

  /**
   * Create a new package
   */
  @Post()
  @ApiOperation({
    summary: 'Create a package',
    description:
      'Creates a new lesson package for the authenticated teacher. Teacher only.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Package created successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  async create(
    @GetUser() user: JwtPayload,
    @Body() createDto: CreatePackageDto,
  ) {
    const pkg = await this.packagesService.create(user.userId, createDto);
    return {
      message: 'Package created successfully',
      package: pkg,
    };
  }

  /**
   * Get a single package by ID (must be owner)
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get my package by ID',
    description:
      'Returns a specific package owned by the authenticated teacher.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const pkg = await this.packagesService.findOne(id);
    return pkg;
  }

  /**
   * Update a package
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update my package',
    description:
      'Updates a package owned by the authenticated teacher. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own packages',
  })
  async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() updateDto: UpdatePackageDto,
  ) {
    const pkg = await this.packagesService.update(id, user.userId, updateDto);
    return {
      message: 'Package updated successfully',
      package: pkg,
    };
  }

  /**
   * Delete a package
   */
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete my package',
    description:
      'Deletes a package owned by the authenticated teacher. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own packages',
  })
  async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
  ) {
    await this.packagesService.delete(id, user.userId);
    return {
      message: 'Package deleted successfully',
    };
  }

  /**
   * Add lessons to a package
   */
  @Post(':id/lessons')
  @ApiOperation({
    summary: 'Add lessons to package',
    description:
      'Adds lessons to a package. All lessons must belong to the teacher. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lessons added successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package or lessons not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only modify your own packages',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Lessons already in package',
  })
  async addLessons(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() addLessonsDto: AddLessonsDto,
  ) {
    const pkg = await this.packagesService.addLessons(
      id,
      user.userId,
      addLessonsDto,
    );
    return {
      message: 'Lessons added successfully',
      package: pkg,
    };
  }

  /**
   * Remove lessons from a package
   */
  @Delete(':id/lessons')
  @ApiOperation({
    summary: 'Remove lessons from package',
    description: 'Removes lessons from a package. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Lessons removed successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only modify your own packages',
  })
  async removeLessons(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() removeLessonsDto: RemoveLessonsDto,
  ) {
    const pkg = await this.packagesService.removeLessons(
      id,
      user.userId,
      removeLessonsDto,
    );
    return {
      message: 'Lessons removed successfully',
      package: pkg,
    };
  }

  /**
   * Toggle package active status
   */
  @Put(':id/toggle-active')
  @ApiOperation({
    summary: 'Toggle package active status',
    description: 'Activates or deactivates a package. Teacher only.',
  })
  @ApiParam({ name: 'id', description: 'Package ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Package status toggled successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  async toggleActive(
    @GetUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body('is_active') isActive: boolean,
  ) {
    const pkg = await this.packagesService.toggleActive(
      id,
      user.userId,
      isActive,
    );
    return {
      message: isActive
        ? 'Package activated successfully'
        : 'Package deactivated successfully',
      package: pkg,
    };
  }
}
