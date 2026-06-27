import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import sharp from 'sharp';

import { FILE_LIMITS, UPLOAD_FOLDERS, UploadFolder } from '../common/constants';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly uploadDir: string;
  private readonly backendUrl: string;

  // Image optimization settings
  private readonly maxImageWidth = 1920;
  private readonly imageQuality = 80;
  private readonly minImageWidth = 400;
  private readonly minImageHeight = 300;
  private readonly maxImageDimension = 8000;

  constructor(private readonly configService: ConfigService) {
    // Read UPLOAD_DIR from environment variable
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') ?? '/app/uploads';

    // Read BACKEND_URL from environment variable
    const url = this.configService.get<string>('BACKEND_URL') ?? '';
    this.backendUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    // Validate critical environment variables in production
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    if (nodeEnv === 'production') {
      const uploadDir = this.configService.get<string>('UPLOAD_DIR');
      if (uploadDir === undefined || uploadDir === '') {
        throw new Error(
          'CRITICAL: UPLOAD_DIR environment variable is not set in production',
        );
      }
      const backendUrl = this.configService.get<string>('BACKEND_URL');
      if (backendUrl === undefined || backendUrl === '') {
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
    if (!Reflect.apply(fs.existsSync, fs, [this.uploadDir])) {
      await Reflect.apply(fsPromises.mkdir, fsPromises, [
        this.uploadDir,
        { recursive: true },
      ]);
    }

    for (const dir of UPLOAD_FOLDERS) {
      const path = join(this.uploadDir, dir);
      if (!Reflect.apply(fs.existsSync, fs, [path])) {
        await Reflect.apply(fsPromises.mkdir, fsPromises, [
          path,
          { recursive: true },
        ]);
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
    if (folder === 'resources') {
      const resourceResult = await this.handleResourceUpload(
        file,
        folder,
        uploadStartTime,
      );
      if (resourceResult !== null) {
        return resourceResult;
      }
    }

    // Handle image uploads (thumbnails/profiles or resources with images)
    return await this.handleImageUpload(file, folder, uploadStartTime);
  }

  private validateFileSize(
    file: Express.Multer.File,
    folder: UploadFolder,
  ): void {
    const maxSize =
      folder === 'resources'
        ? FILE_LIMITS.RESOURCE_MAX_SIZE // 500MB for resources
        : FILE_LIMITS.THUMBNAIL_MAX_SIZE; // 5MB for thumbnails/profiles

    if (file.size > maxSize) {
      this.logger.warn(
        `Upload rejected - File too large: ${String(file.size)} bytes (max: ${String(maxSize)})`,
      );
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${String(maxSize / 1024 / 1024)}MB`,
      );
    }
  }

  private validateContentType(file: Express.Multer.File): void {
    if (file.mimetype !== file.mimetype.toLowerCase()) {
      throw new BadRequestException('Invalid Content-Type header');
    }
  }

  private validatePathTraversal(filename: string): void {
    if (
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      this.logger.error(
        `Upload rejected - Path traversal attempt: ${filename}`,
      );
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
      'zip',
      'rar',
      '7z',
      'tar',
      'gz', // Archives
      'pdf',
      'doc',
      'docx',
      'txt',
      'rtf',
      'odt', // Documents
      'jpg',
      'jpeg',
      'png',
      'gif',
      'webp',
      'bmp', // Images
      'mp4',
      'webm',
      'mov',
      'avi', // Videos
      'js',
      'ts',
      'py',
      'java',
      'cpp',
      'html',
      'css',
      'json',
      'xml', // Code
      'xls',
      'xlsx',
      'csv', // Spreadsheets
      'ppt',
      'pptx', // Presentations
    ];

    if (
      fileExtension === undefined ||
      fileExtension === '' ||
      !allowedResourceExtensions.includes(fileExtension)
    ) {
      this.logger.warn(
        `Upload rejected - Invalid extension: ${fileExtension ?? 'none'}`,
      );
      throw new BadRequestException('Invalid file extension for resources.');
    }

    // For non-image resources, save directly without Sharp processing
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(
      fileExtension,
    );
    if (isImage) {
      return null; // Let handleImageUpload process it
    }

    const filename = `${randomUUID()}.${fileExtension}`;
    const filepath = join(this.uploadDir, folder, filename);
    await Reflect.apply(fsPromises.writeFile, fsPromises, [
      filepath,
      file.buffer,
    ]);

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
    const allowedMimeTypes =
      FILE_LIMITS.ALLOWED_IMAGE_TYPES as readonly string[];
    if (!allowedMimeTypes.includes(file.mimetype)) {
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

    if (
      fileExtension === undefined ||
      fileExtension === '' ||
      !allowedExtensions.includes(fileExtension)
    ) {
      this.logger.warn(
        `Upload rejected - Invalid extension: ${fileExtension ?? 'none'}`,
      );
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
    if (metadata.width === 0 || metadata.height === 0) {
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
        width: this.maxImageWidth,
        height: undefined,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: this.imageQuality,
        progressive: true,
      })
      .toBuffer();

    const compressionRatio = (
      ((file.size - optimizedBuffer.length) / file.size) *
      100
    ).toFixed(2);

    this.logger.log(
      `Image optimized - Original: ${String(file.size)} bytes, Optimized: ${String(optimizedBuffer.length)} bytes, Saved: ${compressionRatio}%`,
    );

    // Save optimized image
    const filename = `${randomUUID()}.jpg`;
    const filepath = join(this.uploadDir, folder, filename);
    await Reflect.apply(fsPromises.writeFile, fsPromises, [
      filepath,
      optimizedBuffer,
    ]);

    const url = `${this.backendUrl}/api/v1/uploads/${folder}/${filename}`;
    const uploadDuration = Date.now() - uploadStartTime;

    this.logger.log(
      `Upload successful - URL: ${url}, Duration: ${String(uploadDuration)}ms`,
    );

    return { url, filename };
  }

  private validateImageDimensions(width: number, height: number): void {
    if (width < this.minImageWidth || height < this.minImageHeight) {
      this.logger.warn(
        `Upload rejected - Image too small: ${String(width)}x${String(height)} (min: ${String(this.minImageWidth)}x${String(this.minImageHeight)})`,
      );
      throw new BadRequestException(
        `Image dimensions too small. Minimum size: ${String(this.minImageWidth)}x${String(this.minImageHeight)}px`,
      );
    }

    if (width > this.maxImageDimension || height > this.maxImageDimension) {
      this.logger.warn(
        `Upload rejected - Image too large: ${String(width)}x${String(height)} (max: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)})`,
      );
      throw new BadRequestException(
        `Image dimensions too large. Maximum size: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)}px`,
      );
    }
  }

  private handleImageError(error: unknown): never {
    this.logger.error(
      `Upload failed - Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );

    if (error instanceof BadRequestException) {
      throw error;
    }

    if (error instanceof Error && error.message.includes('Input buffer')) {
      throw new BadRequestException('Invalid or corrupted image file');
    }

    throw new InternalServerErrorException('Failed to process image upload');
  }

  /**
   * Upload a profile picture with automatic thumbnail generation
   * Returns URLs for both the original (max 1920px) and thumbnail (150x150)
   */
  public async uploadProfilePicture(file: Express.Multer.File): Promise<{
    url: string;
    thumbnailUrl: string;
    filename: string;
    thumbnailFilename: string;
  }> {
    const uploadStartTime = Date.now();
    this.logger.log(
      `Profile picture upload started - Original filename: ${file.originalname}, Size: ${String(file.size)} bytes`,
    );

    // Basic and dimension validations
    await this.validateProfilePicture(file);

    try {
      // Generate unique filename base
      const filenameBase = randomUUID();

      // Process main image (max 1920px width)
      const mainImageBuffer = await sharp(file.buffer)
        .resize({
          width: this.maxImageWidth,
          height: undefined,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({
          quality: this.imageQuality,
          progressive: true,
        })
        .toBuffer();

      // Process thumbnail (150x150, center crop)
      const thumbnailBuffer = await sharp(file.buffer)
        .resize({
          width: 150,
          height: 150,
          fit: 'cover',
          position: 'centre',
        })
        .jpeg({
          quality: 85,
          progressive: true,
        })
        .toBuffer();

      // Save main image
      const filename = `${filenameBase}.jpg`;
      const filepath = join(this.uploadDir, 'profiles', filename);
      await Reflect.apply(fsPromises.writeFile, fsPromises, [
        filepath,
        mainImageBuffer,
      ]);

      // Save thumbnail
      const thumbnailFilename = `${filenameBase}_thumb.jpg`;
      const thumbnailPath = join(this.uploadDir, 'profiles', thumbnailFilename);
      await Reflect.apply(fsPromises.writeFile, fsPromises, [
        thumbnailPath,
        thumbnailBuffer,
      ]);

      const processingTime = Date.now() - uploadStartTime;
      this.logger.log(
        `Profile picture upload completed in ${String(processingTime)}ms - Filename: ${filename}`,
      );

      return {
        url: `/uploads/profiles/${filename}`,
        thumbnailUrl: `/uploads/profiles/${thumbnailFilename}`,
        filename,
        thumbnailFilename,
      };
    } catch (error) {
      this.logger.error(`Profile picture processing failed: ${String(error)}`);
      throw new InternalServerErrorException(
        'Failed to process profile picture',
      );
    }
  }

  /**
   * Validates profile picture file and dimensions
   */
  private async validateProfilePicture(
    file: Express.Multer.File,
  ): Promise<void> {
    // Basic validations
    this.validateFileSize(file, 'profiles');
    this.validateContentType(file);
    this.validatePathTraversal(file.originalname);

    // Validate image MIME type
    const allowedMimeTypes =
      FILE_LIMITS.ALLOWED_IMAGE_TYPES as readonly string[];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      this.logger.warn(`Upload rejected - Invalid MIME type: ${file.mimetype}`);
      throw new BadRequestException(
        `Invalid file type. Only ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')} are allowed`,
      );
    }

    // Validate file extension
    const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];

    if (
      fileExtension === undefined ||
      fileExtension === '' ||
      !allowedExtensions.includes(fileExtension)
    ) {
      throw new BadRequestException(
        'Invalid file extension. Only jpg, jpeg, png, and webp are allowed.',
      );
    }

    try {
      const metadata = await sharp(file.buffer).metadata();
      const { width, height } = metadata;

      // Validate dimensions
      if (width < 150 || height < 150) {
        throw new BadRequestException(
          'Profile picture must be at least 150x150 pixels',
        );
      }

      if (width > this.maxImageDimension || height > this.maxImageDimension) {
        throw new BadRequestException(
          `Image dimensions too large. Maximum size: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)}px`,
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Failed to validate image dimensions');
    }
  }

  public async deleteFile(folder: string, filename: string): Promise<void> {
    this.logger.log(
      `Delete file requested - Folder: ${folder}, File: ${filename}`,
    );

    if (
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
      await Reflect.apply(fsPromises.access, fsPromises, [filepath]);
      await Reflect.apply(fsPromises.unlink, fsPromises, [filepath]);
      this.logger.log(`File deleted successfully - Path: ${filepath}`);
    } catch (error: unknown) {
      let errorCode: string | undefined;
      if (error !== null && typeof error === 'object' && 'code' in error) {
        const errorWithCode = error as { code: unknown };
        if (typeof errorWithCode.code === 'string') {
          errorCode = errorWithCode.code;
        }
      }

      if (errorCode === 'ENOENT') {
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
