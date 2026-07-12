import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import sharp from 'sharp';

import { FILE_LIMITS, UploadFolder } from '../common/constants';
import { biBody } from '../i18n/error-translator.util';
import { StorageService } from '../storage/storage.service';

/**
 * Validates, optimizes (Sharp) and persists non-video uploads. Persistence is
 * delegated to the centralized {@link StorageService} (Cloudflare R2 in
 * production) — this service owns validation + image processing only, and never
 * touches the local filesystem. Lesson videos are handled separately by the
 * Bunny Stream pipeline and never pass through here.
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  // Image optimization settings
  private readonly maxImageWidth = 1920;
  private readonly imageQuality = 80;
  private readonly minImageWidth = 400;
  private readonly minImageHeight = 300;
  private readonly maxImageDimension = 8000;

  /** Optional hard cap on resource size from env (falls back to FILE_LIMITS). */
  private readonly resourceMaxBytes: number;

  constructor(
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
  ) {
    const envMax = Number.parseInt(this.configService.get<string>('UPLOAD_MAX_BYTES') ?? '', 10);
    this.resourceMaxBytes =
      Number.isFinite(envMax) && envMax > 0 ? envMax : FILE_LIMITS.RESOURCE_MAX_SIZE;
  }

  public async uploadFile(
    file: Express.Multer.File,
    folder: UploadFolder,
  ): Promise<{ url: string; filename: string }> {
    const uploadStartTime = Date.now();
    this.logger.log(
      `Upload started - Original filename: ${file.originalname}, Size: ${String(file.size)} bytes, Folder: ${folder}`,
    );

    this.validateFileSize(file, folder);
    this.validateContentType(file);

    // Non-image resources (PDF/doc/zip/…) skip Sharp and store as-is.
    if (folder === 'resources') {
      const resourceResult = await this.handleResourceUpload(file, folder);
      if (resourceResult !== null) {
        return resourceResult;
      }
    }

    return await this.handleImageUpload(file, folder, uploadStartTime);
  }

  private validateFileSize(file: Express.Multer.File, folder: UploadFolder): void {
    const maxSize = folder === 'resources' ? this.resourceMaxBytes : FILE_LIMITS.THUMBNAIL_MAX_SIZE; // 5MB for thumbnails/profiles

    if (file.size > maxSize) {
      this.logger.warn(
        `Upload rejected - File too large: ${String(file.size)} bytes (max: ${String(maxSize)})`,
      );
      throw new BadRequestException(
        biBody(
          `File size exceeds maximum allowed size of ${String(maxSize / 1024 / 1024)}MB`,
          `حجم الملف يتجاوز الحد الأقصى المسموح به وهو ${String(maxSize / 1024 / 1024)} ميجابايت`,
        ),
      );
    }
  }

  private validateContentType(file: Express.Multer.File): void {
    if (file.mimetype !== file.mimetype.toLowerCase()) {
      throw new BadRequestException(
        biBody('Invalid Content-Type header', 'ترويسة Content-Type غير صالحة'),
      );
    }
  }

  private validatePathTraversal(filename: string): void {
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      this.logger.error(`Upload rejected - Path traversal attempt: ${filename}`);
      throw new BadRequestException(biBody('Invalid filename', 'اسم الملف غير صالح'));
    }
  }

  private async handleResourceUpload(
    file: Express.Multer.File,
    folder: string,
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
      this.logger.warn(`Upload rejected - Invalid extension: ${fileExtension ?? 'none'}`);
      throw new BadRequestException(
        biBody('Invalid file extension for resources.', 'امتداد ملف غير صالح للموارد.'),
      );
    }

    // Images fall through to Sharp processing.
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExtension);
    if (isImage) {
      return null;
    }

    const filename = `${randomUUID()}.${fileExtension}`;
    const stored = await this.storageService.upload({
      buffer: file.buffer,
      path: `${folder}/${filename}`,
      contentType: file.mimetype,
      visibility: 'public',
    });

    this.logger.log(`Upload successful (non-image) - key: ${stored.path}`);
    return { url: stored.url, filename };
  }

  private async handleImageUpload(
    file: Express.Multer.File,
    folder: string,
    uploadStartTime: number,
  ): Promise<{ url: string; filename: string }> {
    const allowedMimeTypes = FILE_LIMITS.ALLOWED_IMAGE_TYPES as readonly string[];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      this.logger.warn(`Upload rejected - Invalid MIME type: ${file.mimetype}`);
      throw new BadRequestException(
        biBody(
          `Invalid file type. Only ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')} are allowed`,
          `نوع ملف غير صالح. يُسمح فقط بـ ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')}`,
        ),
      );
    }

    this.validatePathTraversal(file.originalname);

    const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];

    if (
      fileExtension === undefined ||
      fileExtension === '' ||
      !allowedExtensions.includes(fileExtension)
    ) {
      this.logger.warn(`Upload rejected - Invalid extension: ${fileExtension ?? 'none'}`);
      throw new BadRequestException(
        biBody(
          'Invalid file extension. Only jpg, jpeg, png, and webp are allowed.',
          'امتداد ملف غير صالح. يُسمح فقط بـ jpg وjpeg وpng وwebp.',
        ),
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

    if (metadata.width === 0 || metadata.height === 0) {
      this.logger.error('Upload failed - Unable to read image dimensions');
      throw new BadRequestException(biBody('Invalid image file', 'ملف صورة غير صالح'));
    }

    this.validateImageDimensions(metadata.width, metadata.height);

    const optimizedBuffer = await sharp(file.buffer)
      .resize({
        width: this.maxImageWidth,
        height: undefined,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: this.imageQuality, progressive: true })
      .toBuffer();

    const filename = `${randomUUID()}.jpg`;
    const stored = await this.storageService.upload({
      buffer: optimizedBuffer,
      path: `${folder}/${filename}`,
      contentType: 'image/jpeg',
      visibility: 'public',
    });

    this.logger.log(
      `Upload successful - key: ${stored.path}, Duration: ${String(Date.now() - uploadStartTime)}ms`,
    );

    return { url: stored.url, filename };
  }

  private validateImageDimensions(width: number, height: number): void {
    if (width < this.minImageWidth || height < this.minImageHeight) {
      this.logger.warn(`Upload rejected - Image too small: ${String(width)}x${String(height)}`);
      throw new BadRequestException(
        biBody(
          `Image dimensions too small. Minimum size: ${String(this.minImageWidth)}x${String(this.minImageHeight)}px`,
          `أبعاد الصورة صغيرة جدًا. الحد الأدنى للحجم: ${String(this.minImageWidth)}x${String(this.minImageHeight)} بكسل`,
        ),
      );
    }

    if (width > this.maxImageDimension || height > this.maxImageDimension) {
      this.logger.warn(`Upload rejected - Image too large: ${String(width)}x${String(height)}`);
      throw new BadRequestException(
        biBody(
          `Image dimensions too large. Maximum size: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)}px`,
          `أبعاد الصورة كبيرة جدًا. الحد الأقصى للحجم: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)} بكسل`,
        ),
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
      throw new BadRequestException(
        biBody('Invalid or corrupted image file', 'ملف الصورة غير صالح أو تالف'),
      );
    }

    throw new InternalServerErrorException(
      biBody('Failed to process image upload', 'فشل في معالجة رفع الصورة'),
    );
  }

  /**
   * Upload a profile picture with automatic thumbnail generation.
   * Returns public URLs for both the optimized original and the 150x150 thumb.
   */
  public async uploadProfilePicture(file: Express.Multer.File): Promise<{
    url: string;
    thumbnailUrl: string;
    filename: string;
    thumbnailFilename: string;
  }> {
    const uploadStartTime = Date.now();
    this.logger.log(`Profile picture upload started - Size: ${String(file.size)} bytes`);

    await this.validateProfilePicture(file);

    try {
      const filenameBase = randomUUID();

      const [mainImageBuffer, thumbnailBuffer] = await Promise.all([
        sharp(file.buffer)
          .resize({
            width: this.maxImageWidth,
            height: undefined,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({ quality: this.imageQuality, progressive: true })
          .toBuffer(),
        sharp(file.buffer)
          .resize({ width: 150, height: 150, fit: 'cover', position: 'centre' })
          .jpeg({ quality: 85, progressive: true })
          .toBuffer(),
      ]);

      const filename = `${filenameBase}.jpg`;
      const thumbnailFilename = `${filenameBase}_thumb.jpg`;

      const [main, thumb] = await Promise.all([
        this.storageService.upload({
          buffer: mainImageBuffer,
          path: `profiles/${filename}`,
          contentType: 'image/jpeg',
          visibility: 'public',
        }),
        this.storageService.upload({
          buffer: thumbnailBuffer,
          path: `profiles/${thumbnailFilename}`,
          contentType: 'image/jpeg',
          visibility: 'public',
        }),
      ]);

      this.logger.log(
        `Profile picture uploaded in ${String(Date.now() - uploadStartTime)}ms - ${filename}`,
      );

      return {
        url: main.url,
        thumbnailUrl: thumb.url,
        filename,
        thumbnailFilename,
      };
    } catch (error) {
      this.logger.error(`Profile picture processing failed: ${String(error)}`);
      throw new InternalServerErrorException(
        biBody('Failed to process profile picture', 'فشل في معالجة الصورة الشخصية'),
      );
    }
  }

  private async validateProfilePicture(file: Express.Multer.File): Promise<void> {
    this.validateFileSize(file, 'profiles');
    this.validateContentType(file);
    this.validatePathTraversal(file.originalname);

    const allowedMimeTypes = FILE_LIMITS.ALLOWED_IMAGE_TYPES as readonly string[];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      this.logger.warn(`Upload rejected - Invalid MIME type: ${file.mimetype}`);
      throw new BadRequestException(
        biBody(
          `Invalid file type. Only ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')} are allowed`,
          `نوع ملف غير صالح. يُسمح فقط بـ ${FILE_LIMITS.ALLOWED_IMAGE_TYPES.join(', ')}`,
        ),
      );
    }

    const fileExtension = file.originalname.split('.').pop()?.toLowerCase();
    const allowedExtensions = ['jpg', 'jpeg', 'png', 'webp'];

    if (
      fileExtension === undefined ||
      fileExtension === '' ||
      !allowedExtensions.includes(fileExtension)
    ) {
      throw new BadRequestException(
        biBody(
          'Invalid file extension. Only jpg, jpeg, png, and webp are allowed.',
          'امتداد ملف غير صالح. يُسمح فقط بـ jpg وjpeg وpng وwebp.',
        ),
      );
    }

    try {
      const metadata = await sharp(file.buffer).metadata();
      const { width, height } = metadata;

      if (width < 150 || height < 150) {
        throw new BadRequestException(
          biBody(
            'Profile picture must be at least 150x150 pixels',
            'يجب أن تكون الصورة الشخصية 150×150 بكسل على الأقل',
          ),
        );
      }

      if (width > this.maxImageDimension || height > this.maxImageDimension) {
        throw new BadRequestException(
          biBody(
            `Image dimensions too large. Maximum size: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)}px`,
            `أبعاد الصورة كبيرة جدًا. الحد الأقصى للحجم: ${String(this.maxImageDimension)}x${String(this.maxImageDimension)} بكسل`,
          ),
        );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        biBody('Failed to validate image dimensions', 'فشل في التحقق من أبعاد الصورة'),
      );
    }
  }

  /**
   * Delete a previously uploaded asset. `folder`/`filename` map to the storage
   * object key `${folder}/${filename}`.
   */
  public async deleteFile(folder: string, filename: string): Promise<void> {
    this.logger.log(`Delete file requested - ${folder}/${filename}`);

    if (
      folder.includes('..') ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      this.logger.error(`Delete rejected - Path traversal attempt: ${folder}/${filename}`);
      throw new BadRequestException(biBody('Invalid file path', 'مسار ملف غير صالح'));
    }

    await this.storageService.delete(`${folder}/${filename}`);
    this.logger.log(`File deleted - ${folder}/${filename}`);
  }
}
