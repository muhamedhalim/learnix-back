import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FILE_LIMITS, UPLOAD_FOLDERS, UploadFolder } from '../common/constants';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { access,mkdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private uploadDir: string;
  private backendUrl: string;

  // Image optimization settings
  private readonly MAX_IMAGE_WIDTH = 1920;
  private readonly IMAGE_QUALITY = 80;
  private readonly MIN_IMAGE_WIDTH = 400;
  private readonly MIN_IMAGE_HEIGHT = 300;
  private readonly MAX_IMAGE_DIMENSION = 8000;

  constructor(private configService: ConfigService) {
    // Read UPLOAD_DIR from environment variable
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') ?? '/app/uploads';

    // Read BACKEND_URL from environment variable
    const url = this.configService.get<string>('BACKEND_URL') ?? '';
    this.backendUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    // Validate critical environment variables in production
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    if(nodeEnv === 'production') {
      if(!this.configService.get<string>('UPLOAD_DIR')) {
        throw new Error(
          'CRITICAL: UPLOAD_DIR environment variable is not set in production',
        );
      }
      if(!this.configService.get<string>('BACKEND_URL')) {
        throw new Error(
          'CRITICAL: BACKEND_URL environment variable is not set in production',
        );
      }
      // Note: Returning absolute URLs couples service to deployment environment
      // Consider returning relative URLs (/uploads/folder/file.jpg) for better portability
    }

    this.logger.log(`Upload directory configured: ${this.uploadDir}`);
    this.logger.log(`Backend URL configured: ${this.backendUrl}`);

    void this.ensureUploadDir();
  }

  private async ensureUploadDir(): Promise<void> {
    if(!existsSync(this.uploadDir)) {
      await mkdir(this.uploadDir, { recursive: true });
    }

    for(const dir of UPLOAD_FOLDERS) {
      const path = join(this.uploadDir, dir);
      if(!existsSync(path)) {
        await mkdir(path, { recursive: true });
      }
    }
  }

  public async uploadFile(
    file: Express.Multer.File,
    folder: UploadFolder,
  ): Promise<{ url: string; filename: string }> {
    const uploadStartTime = Date.now();
    this.logger.log(
      `Upload started - Original filename: ${file.originalname}, Size: ${String(file.size)} bytes, Folder: ${folder}`,
    );

    // Basic validations
    this.validateFileSize(file, folder);
    this.validateContentType(file);

    // Handle resource folder uploads (non-image files)
    if(folder === 'resources') {
      const resourceResult = await this.handleResourceUpload(file, folder, uploadStartTime);
      if(resourceResult) {
        return resourceResult;
      }
    }

    // Handle image uploads (thumbnails/profiles or resources with images)
    return await this.handleImageUpload(file, folder, uploadStartTime);
  }

  private validateFileSize(file: Express.Multer.File, folder: UploadFolder): void {
    const maxSize =
      folder === 'resources'
        ? FILE_LIMITS.RESOURCE_MAX_SIZE // 500MB for resources
        : FILE_LIMITS.THUMBNAIL_MAX_SIZE; // 5MB for thumbnails/profiles

    if(file.size > maxSize) {
      this.logger.warn(
        `Upload rejected - File too large: ${String(file.size)} bytes (max: ${String(maxSize)})`,
      );
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${String(maxSize / 1024 / 1024)}MB`,
      );
    }
  }

  private validateContentType(file: Express.Multer.File): void {
    if(file.mimetype !== file.mimetype.toLowerCase()) {
      throw new BadRequestException('Invalid Content-Type header');
    }
  }

  private validatePathTraversal(filename: string): void {
    if(filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      this.logger.error(`Upload rejected - Path traversal attempt: ${filename}`);
      throw new BadRequestException('Invalid filename');
    }
  }

  private async handleResourceUpload(
    file: Express.Multer.File,
    folder: string,
    uploadStartTime: number,
  ): Promise<{ url: string; filename: string } | null> {
    this.validatePathTraversal(file.originalname);

    const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
    const allowedResourceExtensions = [
      'zip', 'rar', '7z', 'tar', 'gz', // Archives
      'pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', // Documents
      'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', // Images
      'mp4', 'webm', 'mov', 'avi', // Videos
      'js', 'ts', 'py', 'java', 'cpp', 'html', 'css', 'json', 'xml', // Code
      'xls', 'xlsx', 'csv', // Spreadsheets
      'ppt', 'pptx', // Presentations
    ];

    if(!fileExtension || !allowedResourceExtensions.includes(fileExtension)) {
      this.logger.warn(`Upload rejected - Invalid extension: ${fileExtension ?? 'none'}`);
      throw new BadRequestException('Invalid file extension for resources.');
    }

    // For non-image resources, save directly without Sharp processing
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExtension);
    if(isImage) {
      return null; // Let handleImageUpload process it
    }

    const filename = `${randomUUID()}.${fileExtension}`;
    const filepath = join(this.uploadDir, folder, filename);
    await writeFile(filepath, file.buffer);

    const url = `${this.backendUrl}/api/v1/uploads/${folder}/${filename}`;
    const uploadDuration = Date.now() - uploadStartTime;

    this.logger.log(
      `Upload successful (non-image) - URL: ${url}, Duration: ${String(uploadDuration)}ms`,
    );

    return { url, filename };
  }

  private async handleImageUpload(
    file: Express.Multer.File,
    folder: string,
    uploadStartTime: number,
  ): Promise<{ url: string; filename: string }> {
    // Validate image MIME type
    const allowedMimeTypes = FILE_LIMITS.ALLOWED_IMAGE_TYPES as readonly string[];
    if(!allowedMimeTypes.includes(file.mimetype)) {
      this.logger.warn(`Upload rejected - Invalid MIME type: ${file.mimetype}`);
      throw new BadRequestException(
        `Invalid file type. Only ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')} are allowed`,
      );
    }

    // Validate path traversal
    this.validatePathTraversal(file.originalname);

    // Validate file extension
    const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];

    if(!fileExtension || !allowedExtensions.includes(fileExtension)) {
      this.logger.warn(`Upload rejected - Invalid extension: ${fileExtension ?? 'none'}`);
      throw new BadRequestException(
        'Invalid file extension. Only jpg, jpeg, png, and webp are allowed.',
      );
    }

    try {
      return await this.processImageWithSharp(file, folder, uploadStartTime);
    } catch (error) {
      return this.handleImageError(error);
    }
  }

  private async processImageWithSharp(
    file: Express.Multer.File,
    folder: string,
    uploadStartTime: number,
  ): Promise<{ url: string; filename: string }> {
    const metadata = await sharp(file.buffer).metadata();

    // Validate dimensions
    if(!metadata.width || !metadata.height) {
      this.logger.error('Upload failed - Unable to read image dimensions');
      throw new BadRequestException('Invalid image file');
    }

    this.validateImageDimensions(metadata.width, metadata.height);

    this.logger.log(
      `Image validation passed - Dimensions: ${String(metadata.width)}x${String(metadata.height)}, Format: ${metadata.format}`,
    );

    // Optimize image
    const optimizedBuffer = await sharp(file.buffer)
      .resize({
        width: this.MAX_IMAGE_WIDTH,
        height: undefined,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: this.IMAGE_QUALITY,
        progressive: true,
      })
      .toBuffer();

    const compressionRatio = (((file.size - optimizedBuffer.length) / file.size) * 100).toFixed(2);

    this.logger.log(
      `Image optimized - Original: ${String(file.size)} bytes, Optimized: ${String(optimizedBuffer.length)} bytes, Saved: ${compressionRatio}%`,
    );

    // Save optimized image
    const filename = `${randomUUID()}.jpg`;
    const filepath = join(this.uploadDir, folder, filename);
    await writeFile(filepath, optimizedBuffer);

    const url = `${this.backendUrl}/api/v1/uploads/${folder}/${filename}`;
    const uploadDuration = Date.now() - uploadStartTime;

    this.logger.log(`Upload successful - URL: ${url}, Duration: ${String(uploadDuration)}ms`);

    return { url, filename };
  }

  private validateImageDimensions(width: number, height: number): void {
    if(width < this.MIN_IMAGE_WIDTH || height < this.MIN_IMAGE_HEIGHT) {
      this.logger.warn(
        `Upload rejected - Image too small: ${String(width)}x${String(height)} (min: ${String(this.MIN_IMAGE_WIDTH)}x${String(this.MIN_IMAGE_HEIGHT)})`,
      );
      throw new BadRequestException(
        `Image dimensions too small. Minimum size: ${String(this.MIN_IMAGE_WIDTH)}x${String(this.MIN_IMAGE_HEIGHT)}px`,
      );
    }

    if(width > this.MAX_IMAGE_DIMENSION || height > this.MAX_IMAGE_DIMENSION) {
      this.logger.warn(
        `Upload rejected - Image too large: ${String(width)}x${String(height)} (max: ${String(this.MAX_IMAGE_DIMENSION)}x${String(this.MAX_IMAGE_DIMENSION)})`,
      );
      throw new BadRequestException(
        `Image dimensions too large. Maximum size: ${String(this.MAX_IMAGE_DIMENSION)}x${String(this.MAX_IMAGE_DIMENSION)}px`,
      );
    }
  }

  private handleImageError(error: unknown): never {
    this.logger.error(
      `Upload failed - Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );

    if(error instanceof BadRequestException) {
      throw error;
    }

    if(error instanceof Error && error.message.includes('Input buffer')) {
      throw new BadRequestException('Invalid or corrupted image file');
    }

    throw new InternalServerErrorException('Failed to process image upload');
  }

  public async deleteFile(folder: string, filename: string): Promise<void> {
    this.logger.log(
      `Delete file requested - Folder: ${folder}, File: ${filename}`,
    );

    if(
      folder.includes('..') ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      this.logger.error(
        `Delete rejected - Path traversal attempt: ${folder}/${filename}`,
      );
      throw new BadRequestException('Invalid file path');
    }

    const filepath = join(this.uploadDir, folder, filename);

    try {
      await access(filepath);
      await unlink(filepath);
      this.logger.log(`File deleted successfully - Path: ${filepath}`);
    } catch (error: unknown) {
      const errorCode =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined;

      if(errorCode === 'ENOENT') {
        this.logger.warn(`File not found for deletion: ${filepath}`);
        return;
      }
      this.logger.error(
        `Failed to delete file: ${filepath} - Error code: ${String(errorCode)}`,
      );
      throw new InternalServerErrorException('Failed to delete file');
    }
  }
}
