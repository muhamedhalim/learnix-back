import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { writeFile, unlink, mkdir, access } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import * as sharp from 'sharp';
import { FILE_LIMITS, UPLOAD_FOLDERS, UploadFolder } from '../common/constants';

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
      this.configService.get<string>('UPLOAD_DIR') || '/app/uploads';

    // Read BACKEND_URL from environment variable
    const url = this.configService.get<string>('BACKEND_URL') || '';
    this.backendUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    // Validate critical environment variables in production
    const nodeEnv = this.configService.get<string>('NODE_ENV');
    if (nodeEnv === 'production') {
      if (!this.configService.get<string>('UPLOAD_DIR')) {
        throw new Error(
          'CRITICAL: UPLOAD_DIR environment variable is not set in production',
        );
      }
      if (!this.configService.get<string>('BACKEND_URL')) {
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

  private async ensureUploadDir() {
    if (!existsSync(this.uploadDir)) {
      await mkdir(this.uploadDir, { recursive: true });
    }

    for (const dir of UPLOAD_FOLDERS) {
      const path = join(this.uploadDir, dir);
      if (!existsSync(path)) {
        await mkdir(path, { recursive: true });
      }
    }
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: UploadFolder,
  ): Promise<{ url: string; filename: string }> {
    const uploadStartTime = Date.now();
    this.logger.log(
      `Upload started - Original filename: ${file.originalname}, Size: ${file.size} bytes, Folder: ${folder}`,
    );

    // Validation 1: File buffer exists
    if (!file || !file.buffer) {
      this.logger.error('Upload failed - No file buffer provided');
      throw new BadRequestException('No file provided');
    }

    // Validation 2: File size (folder-specific limits)
    const maxSize =
      folder === 'resources'
        ? FILE_LIMITS.RESOURCE_MAX_SIZE // 500MB for resources
        : FILE_LIMITS.THUMBNAIL_MAX_SIZE; // 5MB for thumbnails/profiles

    if (file.size > maxSize) {
      this.logger.warn(
        `Upload rejected - File too large: ${file.size} bytes (max: ${maxSize})`,
      );
      throw new BadRequestException(
        `File size exceeds maximum allowed size of ${maxSize / 1024 / 1024}MB`,
      );
    }

    // NOTE: Virus scanning not implemented as only admin/instructor users can upload files.
    // If non-admin uploads are enabled in the future, integrate ClamAV or cloud-based scanning service.

    // Validation 3: Content-Type header validation
    if (file.mimetype !== file.mimetype.toLowerCase()) {
      throw new BadRequestException('Invalid Content-Type header');
    }

    // For resources folder, allow more file types
    if (folder === 'resources') {
      // Validation 4: Path traversal prevention
      if (
        file.originalname.includes('..') ||
        file.originalname.includes('/') ||
        file.originalname.includes('\\')
      ) {
        this.logger.error(
          `Upload rejected - Path traversal attempt: ${file.originalname}`,
        );
        throw new BadRequestException('Invalid filename');
      }

      // Validation 5: File extension for resources (broader set)
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
        // 'svg', // Removed: XSS risk via embedded scripts
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
        !fileExtension ||
        !allowedResourceExtensions.includes(fileExtension)
      ) {
        this.logger.warn(
          `Upload rejected - Invalid extension: ${fileExtension}`,
        );
        throw new BadRequestException('Invalid file extension for resources.');
      }

      // For non-image resources, save directly without Sharp processing
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(
        fileExtension,
      );

      if (!isImage) {
        const filename = `${randomUUID()}.${fileExtension}`;
        const filepath = join(this.uploadDir, folder, filename);

        await writeFile(filepath, file.buffer);

        const url = `${this.backendUrl}/api/v1/uploads/${folder}/${filename}`;
        const uploadDuration = Date.now() - uploadStartTime;

        this.logger.log(
          `Upload successful (non-image) - URL: ${url}, Duration: ${uploadDuration}ms`,
        );

        return { url, filename };
      }
    }

    // Validation 6: MIME type (for images only)
    const allowedMimeTypes =
      FILE_LIMITS.ALLOWED_IMAGE_TYPES as readonly string[];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      this.logger.warn(`Upload rejected - Invalid MIME type: ${file.mimetype}`);
      throw new BadRequestException(
        `Invalid file type. Only ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')} are allowed`,
      );
    }

    // Validation 7: Path traversal prevention
    if (
      file.originalname.includes('..') ||
      file.originalname.includes('/') ||
      file.originalname.includes('\\')
    ) {
      this.logger.error(
        `Upload rejected - Path traversal attempt: ${file.originalname}`,
      );
      throw new BadRequestException('Invalid filename');
    }

    // Validation 8: File extension
    const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];

    if (!fileExtension || !allowedExtensions.includes(fileExtension)) {
      this.logger.warn(`Upload rejected - Invalid extension: ${fileExtension}`);
      throw new BadRequestException(
        'Invalid file extension. Only jpg, jpeg, png, and webp are allowed.',
      );
    }

    try {
      // Get image metadata for dimension validation
      const metadata = await sharp(file.buffer).metadata();

      // Validation 9: Image dimensions
      if (!metadata.width || !metadata.height) {
        this.logger.error('Upload failed - Unable to read image dimensions');
        throw new BadRequestException('Invalid image file');
      }

      if (
        metadata.width < this.MIN_IMAGE_WIDTH ||
        metadata.height < this.MIN_IMAGE_HEIGHT
      ) {
        this.logger.warn(
          `Upload rejected - Image too small: ${metadata.width}x${metadata.height} (min: ${this.MIN_IMAGE_WIDTH}x${this.MIN_IMAGE_HEIGHT})`,
        );
        throw new BadRequestException(
          `Image dimensions too small. Minimum size: ${this.MIN_IMAGE_WIDTH}x${this.MIN_IMAGE_HEIGHT}px`,
        );
      }

      if (
        metadata.width > this.MAX_IMAGE_DIMENSION ||
        metadata.height > this.MAX_IMAGE_DIMENSION
      ) {
        this.logger.warn(
          `Upload rejected - Image too large: ${metadata.width}x${metadata.height} (max: ${this.MAX_IMAGE_DIMENSION}x${this.MAX_IMAGE_DIMENSION})`,
        );
        throw new BadRequestException(
          `Image dimensions too large. Maximum size: ${this.MAX_IMAGE_DIMENSION}x${this.MAX_IMAGE_DIMENSION}px`,
        );
      }

      this.logger.log(
        `Image validation passed - Dimensions: ${metadata.width}x${metadata.height}, Format: ${metadata.format}`,
      );

      // Image optimization with Sharp
      // Resize if width exceeds max, compress, and convert to JPEG for consistency
      const optimizedBuffer = await sharp(file.buffer)
        .resize({
          width: this.MAX_IMAGE_WIDTH,
          height: undefined, // Maintain aspect ratio
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({
          quality: this.IMAGE_QUALITY,
          progressive: true, // Better loading experience
        })
        .toBuffer();

      const optimizedSize = optimizedBuffer.length;
      const compressionRatio = (
        ((file.size - optimizedSize) / file.size) *
        100
      ).toFixed(2);

      this.logger.log(
        `Image optimized - Original: ${file.size} bytes, Optimized: ${optimizedSize} bytes, Saved: ${compressionRatio}%`,
      );

      // Generate unique filename (always .jpg after Sharp conversion)
      const filename = `${randomUUID()}.jpg`;
      const filepath = join(this.uploadDir, folder, filename);

      // Write optimized file to disk
      await writeFile(filepath, optimizedBuffer);

      const url = `${this.backendUrl}/api/v1/uploads/${folder}/${filename}`;
      const uploadDuration = Date.now() - uploadStartTime;

      this.logger.log(
        `Upload successful - URL: ${url}, Duration: ${uploadDuration}ms`,
      );

      return { url, filename };
    } catch (error) {
      this.logger.error(
        `Upload failed - Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );

      // Re-throw known validation errors
      if (error instanceof BadRequestException) {
        throw error;
      }

      // Handle Sharp-specific errors
      if (error instanceof Error && error.message.includes('Input buffer')) {
        throw new BadRequestException('Invalid or corrupted image file');
      }

      throw new InternalServerErrorException('Failed to process image upload');
    }
  }

  async deleteFile(folder: string, filename: string): Promise<void> {
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

      if (errorCode === 'ENOENT') {
        this.logger.warn(`File not found for deletion: ${filepath}`);
        return;
      }
      this.logger.error(
        `Failed to delete file: ${filepath} - Error code: ${errorCode}`,
      );
      throw new InternalServerErrorException('Failed to delete file');
    }
  }
}
