import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UploadService } from '../../uploads/upload.service';
import { CreateSubjectDto, UpdateSubjectDto } from '../dto';
import { SubjectsService } from '../subjects.service';

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
  public async create(
    @Body() createSubjectDto: CreateSubjectDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<unknown> {
    const dtoToUse = new CreateSubjectDto();
    Object.assign(dtoToUse, createSubjectDto);

    // Upload thumbnail if provided
    if (file) {
      const uploadResult = await this.uploadService.uploadFile(
        file,
        'thumbnails',
      );
      dtoToUse.thumbnail = uploadResult.url;
    }

    const subject = await this.subjectsService.create(dtoToUse);
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
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject with this title already exists',
  })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSubjectDto: UpdateSubjectDto,
  ): Promise<unknown> {
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
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Cannot delete subject with existing lessons',
  })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    await this.subjectsService.remove(id);
    return {
      message: 'Subject deleted successfully',
    };
  }

  /**
   * Get all subjects with counts (admin dashboard)
   * Admin only
   */
  @Get('counts')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subjects with counts retrieved successfully',
  })
  public async getSubjectsWithCounts(): Promise<unknown> {
    return await this.subjectsService.getSubjectsWithCounts();
  }
}
