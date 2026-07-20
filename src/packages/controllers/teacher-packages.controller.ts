import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  AddLessonsDto,
  CreateChapterDto,
  CreatePackageDto,
  TeacherPackageFilterDto,
  RemoveLessonsDto,
  ReorderCurriculumDto,
  UpdateChapterDto,
  UpdateCourseStatusDto,
  UpdatePackageDto,
} from '../dto';
import { PackagesService } from '../packages.service';

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
  public async findMyPackages(
    @GetUser() user: JwtPayload,
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
    return await this.packagesService.findMyPackages(user.userId, filter);
  }

  /**
   * Create a new package
   */
  @Post()
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  public async create(
    @GetUser() user: JwtPayload,
    @Body() createDto: CreatePackageDto,
  ): Promise<{ message: string; package: unknown }> {
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
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  public async findOne(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    return await this.packagesService.findOneForTeacher(id, user.userId);
  }

  /**
   * Update a package
   */
  @Put(':id')
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only update your own packages',
  })
  public async update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDto: UpdatePackageDto,
  ): Promise<{ message: string; package: unknown }> {
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
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only delete your own packages',
  })
  public async delete(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    await this.packagesService.delete(id, user.userId);
    return {
      message: 'Package deleted successfully',
    };
  }

  /**
   * Add lessons to a package
   */
  @Post(':id/lessons')
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Lessons already in package',
  })
  public async addLessons(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() addLessonsDto: AddLessonsDto,
  ): Promise<{ message: string; package: unknown }> {
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
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'You can only modify your own packages',
  })
  public async removeLessons(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() removeLessonsDto: RemoveLessonsDto,
  ): Promise<{ message: string; package: unknown }> {
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
  @Patch(':id/active')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Package not found',
  })
  public async toggleActive(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body('is_active') isActive: boolean,
  ): Promise<{ message: string; package: unknown }> {
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

  /* ===================== Course CMS: chapters & status ===================== */

  @Get(':id/chapters')
  @ApiOperation({ summary: 'List a course\'s chapters' })
  public async listChapters(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: unknown[] }> {
    const data = await this.packagesService.listChapters(id, user.userId);
    return { data };
  }

  @Post(':id/chapters')
  @ApiOperation({ summary: 'Create a chapter in a course' })
  public async createChapter(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateChapterDto,
  ): Promise<{ message: string; data: unknown }> {
    const chapter = await this.packagesService.createChapter(
      id,
      user.userId,
      dto,
    );
    return { message: 'Chapter created successfully', data: chapter };
  }

  @Patch(':id/chapters/:chapterId')
  @ApiOperation({ summary: 'Rename or reorder a chapter' })
  public async updateChapter(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
    @Body() dto: UpdateChapterDto,
  ): Promise<{ message: string; data: unknown }> {
    const chapter = await this.packagesService.updateChapter(
      id,
      chapterId,
      user.userId,
      dto,
    );
    return { message: 'Chapter updated successfully', data: chapter };
  }

  @Delete(':id/chapters/:chapterId')
  @ApiOperation({ summary: 'Delete a chapter (its lessons become top-level)' })
  public async deleteChapter(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('chapterId', ParseUUIDPipe) chapterId: string,
  ): Promise<{ message: string }> {
    await this.packagesService.deleteChapter(id, chapterId, user.userId);
    return { message: 'Chapter deleted successfully' };
  }

  @Patch(':id/curriculum')
  @ApiOperation({
    summary: 'Persist curriculum order (lesson positions, chapter membership)',
  })
  public async reorderCurriculum(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderCurriculumDto,
  ): Promise<{ message: string; data: unknown }> {
    const course = await this.packagesService.reorderCurriculum(
      id,
      user.userId,
      dto,
    );
    return { message: 'Curriculum updated successfully', data: course };
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Update course publishing status (draft/published/hidden/archived)',
  })
  public async updateStatus(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCourseStatusDto,
  ): Promise<{ message: string; data: unknown }> {
    const course = await this.packagesService.updateStatus(
      id,
      user.userId,
      dto.status,
    );
    return { message: 'Course status updated successfully', data: course };
  }
}
