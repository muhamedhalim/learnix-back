import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiParam,ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { THROTTLE, UPLOAD_FOLDERS } from '../common/constants';
import { SkipCsrf } from '../common/guards/csrf.guard';
import type { Response } from 'express';
import { access } from 'fs/promises';
import { join } from 'path';

@Controller('uploads')
@Throttle({ default: THROTTLE.DEFAULT })
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name);
  private uploadDir: string;

  constructor(private configService: ConfigService) {
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') ?? '/app/uploads';
    this.logger.log(`Uploads controller serving from: ${this.uploadDir}`);
  }

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
    if(!validFolders.includes(folder)) {
      this.logger.warn(`Invalid folder requested: ${folder}`);
      throw new BadRequestException(
        `Invalid folder. Allowed: ${UPLOAD_FOLDERS.join(', ')}`,
      );
    }

    // Validation 2: Path traversal prevention
    if(
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
    if(!filename.includes('.')) {
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
