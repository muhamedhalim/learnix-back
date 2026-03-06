import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { access } from 'fs/promises';
import { join } from 'path';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { THROTTLE, UPLOAD_FOLDERS } from '../common/constants';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { SkipCsrf } from '../common/guards/csrf.guard';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { UserRole } from '../users/entities/user-role.enum';

import type {
  FileDeleteResponseDto,
  FileDetailsDto,
  FileListResponseDto,
} from './dto/file-details.dto';
import { FileManagementService } from './file-management.service';

@ApiTags('Uploads')
@Controller('uploads')
@Throttle({ default: THROTTLE.DEFAULT })
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);
  private readonly uploadDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly fileManagementService: FileManagementService,
  ) {
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') ?? '/app/uploads';
    this.logger.log(`Uploads controller serving from: ${this.uploadDir}`);
  }

  // ==================== FILE MANAGEMENT ENDPOINTS ====================

  /**
   * List all files uploaded by the current teacher
   */
  @Get('teacher/files')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('teacher')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List all files uploaded by teacher',
    description:
      'Returns a list of all files uploaded by the current teacher, with usage information.',
  })
  @ApiQuery({
    name: 'folder',
    required: false,
    enum: ['resources', 'thumbnails', 'profiles'],
    description: 'Filter by folder type',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of uploaded files',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Teacher role required',
  })
  public async getTeacherFiles(
    @GetUser() user: JwtPayload,
    @Query('folder') folder?: 'resources' | 'thumbnails' | 'profiles',
  ): Promise<FileListResponseDto> {
    const files = await this.fileManagementService.getUserFiles(
      user.userId,
      folder,
    );
    return { data: files };
  }

  /**
   * List all files for admin (any user's files)
   */
  @Get('admin/files')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'List files for a specific user (Admin only)',
    description:
      'Returns a list of all files uploaded by a specific user. Admin only.',
  })
  @ApiQuery({
    name: 'userId',
    required: true,
    type: String,
    description: 'User ID to get files for',
  })
  @ApiQuery({
    name: 'folder',
    required: false,
    enum: ['resources', 'thumbnails', 'profiles'],
    description: 'Filter by folder type',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of uploaded files',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Admin role required',
  })
  public async getAdminUserFiles(
    @Query('userId', ParseUUIDPipe) userId: string,
    @Query('folder') folder?: 'resources' | 'thumbnails' | 'profiles',
  ): Promise<FileListResponseDto> {
    const files = await this.fileManagementService.getUserFiles(userId, folder);
    return { data: files };
  }

  /**
   * Get file usage information
   */
  @Get('files/:fileId/usage')
  @UseGuards(HybridAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Get file usage information',
    description:
      'Returns information about where a file is being used (lessons, books, profiles, etc.).',
  })
  @ApiParam({
    name: 'fileId',
    type: String,
    description: 'File UUID',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'File usage information',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'File not found',
  })
  public async getFileUsage(
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<{ data: FileDetailsDto }> {
    const file = await this.fileManagementService.getFileById(fileId);
    if (file === null) {
      throw new NotFoundException('File not found');
    }

    const usage = await this.fileManagementService.getFileUsage(file.filename);

    return {
      data: {
        id: file.id,
        filename: file.filename,
        originalFilename: file.original_filename,
        folder: file.folder,
        mimeType: file.mime_type,
        size: file.size,
        uploadedAt: file.created_at,
        usedIn: usage.usedIn,
      },
    };
  }

  /**
   * Delete an uploaded file
   */
  @Delete('files/:fileId')
  @UseGuards(HybridAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Delete an uploaded file',
    description:
      'Deletes an uploaded file. If the file is in use and force=false, returns a conflict error with usage details. ' +
      'Only the uploader or an admin can delete a file.',
  })
  @ApiParam({
    name: 'fileId',
    type: String,
    description: 'File UUID',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: Boolean,
    description: 'Force delete even if file is in use (soft delete only)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'File deleted successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'File not found',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Forbidden - Not file owner',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'File is in use - cannot delete without force',
  })
  public async deleteFile(
    @GetUser() user: JwtPayload,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Query('force', new ParseBoolPipe({ optional: true })) force?: boolean,
  ): Promise<FileDeleteResponseDto> {
    await this.fileManagementService.deleteFile(
      user.userId,
      user.role as UserRole,
      fileId,
      force ?? false,
    );

    return { message: 'File deleted successfully' };
  }

  // ==================== FILE SERVING ENDPOINT ====================

  @Get(':folder/:filename')
  @SkipCsrf()
  @ApiOperation({
    summary: 'Serve uploaded files (thumbnails, profiles, resources)',
    description:
      'Public endpoint for serving uploaded files with proper CORS headers. ' +
      'Supports folders: thumbnails, profiles, resources. ' +
      'Rate limited to prevent abuse (5 requests/minute).',
  })
  @ApiParam({
    name: 'folder',
    enum: UPLOAD_FOLDERS,
    description: 'Upload folder type',
    example: 'thumbnails',
  })
  @ApiParam({
    name: 'filename',
    description: 'File name with extension',
    example: 'abc123.jpg',
  })
  @ApiResponse({
    status: 200,
    description: 'File served successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid folder or filename (path traversal attempt)',
  })
  @ApiResponse({
    status: 404,
    description: 'File not found',
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests (rate limit exceeded)',
  })
  public async serveUploadedFile(
    @Param('folder') folder: string,
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    // Validation 1: Folder must be one of allowed folders
    const validFolders: readonly string[] = UPLOAD_FOLDERS;
    if (!validFolders.includes(folder)) {
      this.logger.warn(`Invalid folder requested: ${folder}`);
      throw new BadRequestException(
        `Invalid folder. Allowed: ${UPLOAD_FOLDERS.join(', ')}`,
      );
    }

    // Validation 2: Path traversal prevention
    if (
      folder.includes('..') ||
      folder.includes('/') ||
      folder.includes('\\') ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      this.logger.error(
        `Path traversal attempt: folder=${folder}, filename=${filename}`,
      );
      throw new BadRequestException('Invalid file path');
    }

    // Validation 3: Filename must have an extension
    if (!filename.includes('.')) {
      this.logger.warn(`Filename missing extension: ${filename}`);
      throw new BadRequestException('Invalid filename');
    }

    // Build safe file path
    const filepath = join(this.uploadDir, folder, filename);

    // Validation 4: File must exist
    try {
      await access(filepath);
    } catch {
      this.logger.warn(`File not found: ${filepath}`);
      throw new NotFoundException('File not found');
    }

    // Set explicit CORS headers for cross-origin image loading
    // This ensures images can be loaded from www.datastic.org frontend
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Serve file with proper headers
    this.logger.log(`Serving file: ${filepath}`);
    res.sendFile(filepath);
  }
}
