import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { GetUser } from '../common/decorators/get-user.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { extensionMatchesMime, hasExpectedMagicBytes } from '../common/utils/file-signature.util';
import { biBody } from '../i18n/error-translator.util';
import { MediaService } from '../media/media.service';
import { StorageService } from '../storage/storage.service';

interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const FILE_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
  'application/vnd.ms-powerpoint',
  'application/zip',
  'application/x-zip-compressed',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
];
const MAX_IMAGE = 5 * 1024 * 1024; // 5 MB
const MAX_FILE = 50 * 1024 * 1024; // 50 MB
const MAX_BOOK = 200 * 1024 * 1024; // 200 MB — paid book PDFs can be large

/** Map a mimetype to the logical attachment type used by the frontend. */
function logicalType(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.includes('word')) return 'docx';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'pptx';
  if (mime.includes('zip')) return 'zip';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

@ApiTags('Teacher Uploads')
@Controller('teacher/uploads')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherUploadsController {
  constructor(
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  // `limits.fileSize` makes Multer stop reading (and reject with a
  // LIMIT_FILE_SIZE error, mapped to HTTP 413 by HttpExceptionFilter) as soon
  // as the byte ceiling is crossed, so an oversized body is never fully
  // buffered into this process's memory. The in-handler `file.size` check
  // stays as defence-in-depth for the exact same ceiling. `files: 1` blocks
  // multipart payloads that smuggle extra file parts.
  @Post('image')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE, files: 1 } }))
  @ApiOperation({ summary: 'Upload an image (thumbnail). Returns a public URL.' })
  public async uploadImage(@GetUser() user: JwtPayload, @UploadedFile() file?: MulterFile) {
    // Per-teacher folder: the prefix is the ownership proof checked before a cover is attached or deleted.
    return this.handle(file, IMAGE_TYPES, MAX_IMAGE, `images/${user.userId}`);
  }

  @Post('file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE, files: 1 } }))
  @ApiOperation({ summary: 'Upload a private lesson resource. Returns an opaque reference.' })
  public async uploadFile(
    @GetUser() user: JwtPayload,
    @UploadedFile() file?: MulterFile,
  ): Promise<{ upload_ref: string; name: string; type: string; size: number }> {
    const uploaded = await this.handle(
      file,
      FILE_TYPES,
      MAX_FILE,
      `lesson-resources/${user.userId}`,
      true,
    );
    return {
      upload_ref: uploaded.key,
      name: uploaded.name,
      type: uploaded.type,
      size: uploaded.size,
    };
  }

  /**
   * Upload a paid-book PDF as a PRIVATE object. Unlike the public endpoints this
   * returns only the storage KEY (never a public URL) — the object is never
   * publicly reachable and can only be retrieved via a purchase-gated backend
   * download route (see BookPurchasesService.getDownloadObject). Store the
   * returned `key` in the book's `book_file`.
   */
  @Post('book-file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BOOK, files: 1 } }))
  @ApiOperation({
    summary: 'Upload a paid-book PDF privately. Returns a storage key (no URL).',
  })
  public async uploadBookFile(
    @GetUser() user: JwtPayload,
    @UploadedFile() file?: MulterFile,
  ): Promise<{ key: string; name: string; size: number }> {
    if (!file) {
      throw new BadRequestException(biBody('No file provided', 'لم يتم توفير أي ملف'));
    }
    if (file.mimetype !== 'application/pdf') {
      throw new BadRequestException(
        biBody('Book files must be PDF', 'يجب أن تكون ملفات الكتب بصيغة PDF'),
      );
    }
    if (
      !extensionMatchesMime(file.originalname, file.mimetype) ||
      !hasExpectedMagicBytes(file.mimetype, file.buffer)
    ) {
      throw new BadRequestException(
        biBody(
          'File content does not match a valid PDF',
          'Ù…Ø­ØªÙˆÙ‰ Ø§Ù„Ù…Ù„Ù Ù„Ø§ ÙŠØ·Ø§Ø¨Ù‚ Ù…Ù„Ù PDF ØµØ§Ù„Ø­',
        ),
      );
    }
    if (file.size > MAX_BOOK) {
      throw new BadRequestException(
        biBody(
          `File too large (max ${Math.round(MAX_BOOK / (1024 * 1024))} MB)`,
          `حجم الملف كبير جدًا (الحد الأقصى ${Math.round(MAX_BOOK / (1024 * 1024))} ميجابايت)`,
        ),
      );
    }
    const key = `books/${user.userId}/${randomUUID()}.pdf`;
    const stored = await this.storage.upload({
      buffer: file.buffer,
      path: key,
      contentType: file.mimetype,
      visibility: 'private',
    });
    return { key: stored.path, name: file.originalname, size: stored.size };
  }

  private async handle(
    file: MulterFile | undefined,
    allowed: string[],
    maxBytes: number,
    folder: string,
    privateObject = false,
  ): Promise<{ url: string; key: string; name: string; type: string; size: number }> {
    if (!file) {
      throw new BadRequestException(biBody('No file provided', 'لم يتم توفير أي ملف'));
    }
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException(
        biBody(`Unsupported file type: ${file.mimetype}`, `نوع ملف غير مدعوم: ${file.mimetype}`),
      );
    }
    if (
      file.originalname.includes('..') ||
      file.originalname.includes('/') ||
      file.originalname.includes('\\') ||
      !extensionMatchesMime(file.originalname, file.mimetype) ||
      !hasExpectedMagicBytes(file.mimetype, file.buffer)
    ) {
      throw new BadRequestException(
        biBody(
          'File extension, type, or content is invalid',
          'Ø§Ù…ØªØ¯Ø§Ø¯ Ø§Ù„Ù…Ù„Ù Ø£Ùˆ Ù†ÙˆØ¹Ù‡ Ø£Ùˆ Ù…Ø­ØªÙˆØ§Ù‡ ØºÙŠØ± ØµØ§Ù„Ø­',
        ),
      );
    }
    if (file.size > maxBytes) {
      throw new BadRequestException(
        biBody(
          `File too large (max ${Math.round(maxBytes / (1024 * 1024))} MB)`,
          `حجم الملف كبير جدًا (الحد الأقصى ${Math.round(maxBytes / (1024 * 1024))} ميجابايت)`,
        ),
      );
    }
    const ext = extname(file.originalname) || '';
    const path = `${folder}/${randomUUID()}${ext}`;
    const stored = await this.storage.upload({
      buffer: file.buffer,
      path,
      contentType: file.mimetype,
      visibility: privateObject ? 'private' : 'public',
    });
    return {
      url: privateObject ? '' : this.media.buildPublicUrl(stored.path),
      key: stored.path,
      name: file.originalname,
      type: logicalType(file.mimetype),
      size: stored.size,
    };
  }
}
