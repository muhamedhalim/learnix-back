import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
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
import { FILE_LIMITS } from '../../common/constants';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { UploadService } from '../../uploads/upload.service';
import {
  AdminSubjectFilterDto,
  ApproveSubjectDto,
  CreateSubjectDto,
  RejectSubjectDto,
  SubjectFilterDto,
  SuspendSubjectDto,
  UpdateSubjectDto,
} from '../dto';
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
  @UseInterceptors(
    FileInterceptor('thumbnail', {
      limits: { fileSize: FILE_LIMITS.THUMBNAIL_MAX_SIZE, files: 1 },
    }),
  )
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
        thumbnail: { type: 'string', format: 'binary' },
      },
      required: ['name'],
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
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
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

    const subject = await this.subjectsService.create(dtoToUse, {
      actorId: user.userId,
      ipAddress: ip,
    });
    return {
      message: 'Subject created successfully',
      subject,
    };
  }

  /**
   * List every subject, in any status, with its owner.
   * Admin only.
   */
  @Get()
  @ApiOperation({
    summary: 'List all subjects',
    description:
      'Returns every subject regardless of status, optionally filtered by ' +
      'status or owning teacher. Admin only.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Subjects retrieved successfully',
  })
  public async findAll(@Query() filter: AdminSubjectFilterDto): Promise<unknown> {
    return await this.subjectsService.findAllForAdmin(filter);
  }

  /**
   * Subjects awaiting review.
   * Admin only.
   */
  @Get('pending')
  @ApiOperation({
    summary: 'List subjects awaiting approval',
    description: 'Returns teacher-submitted subjects that still need a review decision.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Pending subjects retrieved successfully',
  })
  public async findPending(@Query() filter: SubjectFilterDto): Promise<unknown> {
    return await this.subjectsService.findPendingForAdmin(filter);
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
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.update(id, updateSubjectDto, {
      actorId: user.userId,
      ipAddress: ip,
    });
    return {
      message: 'Subject updated successfully',
      subject,
    };
  }

  /**
   * Approve a pending (or previously rejected) subject, publishing it.
   * Admin only.
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a subject' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject is not awaiting approval',
  })
  public async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() approveDto: ApproveSubjectDto,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.approve(id, user.userId, approveDto, ip);
    return {
      message: 'Subject approved successfully',
      subject,
    };
  }

  /**
   * Reject a pending subject. The reason is shown to the owning teacher.
   * Admin only.
   */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a subject' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Rejection reason is required',
  })
  public async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() rejectDto: RejectSubjectDto,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.reject(id, user.userId, rejectDto, ip);
    return {
      message: 'Subject rejected successfully',
      subject,
    };
  }

  /**
   * Suspend an approved subject. Existing content keeps its link and stays
   * editable; the subject simply leaves every catalogue and picker.
   * Admin only.
   */
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Suspend a subject' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Only approved subjects can be suspended',
  })
  public async suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() suspendDto: SuspendSubjectDto,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.suspend(id, user.userId, suspendDto, ip);
    return {
      message: 'Subject suspended successfully',
      subject,
    };
  }

  /**
   * Lift a suspension (or reinstate a rejected subject).
   * Admin only.
   */
  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate a subject' })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Subject is not suspended or rejected',
  })
  public async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    const subject = await this.subjectsService.reactivate(id, user.userId, ip);
    return {
      message: 'Subject reactivated successfully',
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
    @GetUser() user: JwtPayload,
    @Ip() ip: string,
  ): Promise<unknown> {
    await this.subjectsService.remove(id, { actorId: user.userId, ipAddress: ip });
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
