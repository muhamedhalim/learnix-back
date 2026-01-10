import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  ParseIntPipe,
  HttpStatus,
  HttpCode,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { SubjectsService } from '../subjects.service';
import { CreateSubjectDto, UpdateSubjectDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UploadService } from '../../uploads/upload.service';

@ApiTags('Admin - Subjects')
@Controller('admin/subjects')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminSubjectsController {
  constructor(
    private readonly subjectsService: SubjectsService,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * Create a new subject with thumbnail upload
   * Admin only
   */
  @Post()
  @UseInterceptors(FileInterceptor('thumbnail'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Create a new subject',
    description: 'Creates a new subject with optional thumbnail. Admin only.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'الفيزياء' },
        description: {
          type: 'string',
          example: 'مادة الفيزياء للصف الثالث الثانوي',
        },
        gradeLevel: {
          type: 'string',
          enum: ['grade_10', 'grade_11', 'grade_12'],
          example: 'grade_12',
        },
        thumbnail: { type: 'string', format: 'binary' },
      },
      required: ['name', 'gradeLevel'],
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Subject created successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject with this name already exists',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (admin only)',
  })
  async create(
    @Body() createSubjectDto: CreateSubjectDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // Upload thumbnail if provided
    if (file) {
      const uploadResult = await this.uploadService.uploadFile(
        file,
        'thumbnails',
      );
      createSubjectDto.thumbnail = uploadResult.url;
    }

    const subject = await this.subjectsService.create(createSubjectDto);
    return {
      message: 'Subject created successfully',
      subject,
    };
  }

  /**
   * Update an existing subject
   * Admin only
   */
  @Put(':id')
  @ApiOperation({
    summary: 'Update a subject',
    description: 'Updates an existing subject. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Subject ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subject updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject with this title already exists',
  })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateSubjectDto: UpdateSubjectDto,
  ) {
    const subject = await this.subjectsService.update(id, updateSubjectDto);
    return {
      message: 'Subject updated successfully',
      subject,
    };
  }

  /**
   * Delete a subject (soft delete)
   * Admin only
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a subject',
    description: 'Soft deletes a subject. Admin only.',
  })
  @ApiParam({ name: 'id', description: 'Subject ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subject deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Subject not found',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Cannot delete subject with existing lessons',
  })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.subjectsService.remove(id);
    return {
      message: 'Subject deleted successfully',
    };
  }

  /**
   * Get all subjects with counts (admin dashboard)
   * Admin only
   */
  @Get('with-counts')
  @ApiOperation({
    summary: 'Get subjects with counts',
    description:
      'Returns all subjects with teacher and lesson counts for admin dashboard.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subjects with counts retrieved successfully',
  })
  async getSubjectsWithCounts() {
    return this.subjectsService.getSubjectsWithCounts();
  }
}
