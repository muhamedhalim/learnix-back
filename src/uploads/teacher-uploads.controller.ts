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
import { biBody } from '../i18n/error-translator.util';
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
  constructor(private readonly storage: StorageService) {}

  @Post('image')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload an image (thumbnail). Returns a public URL.' })
  public async uploadImage(@UploadedFile() file?: MulterFile) {
    return this.handle(file, IMAGE_TYPES, MAX_IMAGE, 'images');
  }

  @Post('file')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload an attachment/resource. Returns a public URL.' })
  public async uploadFile(@UploadedFile() file?: MulterFile) {
    return this.handle(file, FILE_TYPES, MAX_FILE, 'attachments');
  }

  /**
   * Upload a paid-book PDF as a PRIVATE object. Unlike the public endpoints this
   * returns only the storage KEY (never a public URL) — the object is never
   * publicly reachable and can only be retrieved via a purchase-gated backend
   * download route (see BookPurchasesService.getDownloadObject). Store the
   * returned `key` in the book's `book_file`.
   */
  @Post('book-file')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a paid-book PDF privately. Returns a storage key (no URL).',
  })
  public async uploadBookFile(
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
    if (file.size > MAX_BOOK) {
      throw new BadRequestException(
        biBody(
          `File too large (max ${Math.round(MAX_BOOK / (1024 * 1024))} MB)`,
          `حجم الملف كبير جدًا (الحد الأقصى ${Math.round(MAX_BOOK / (1024 * 1024))} ميجابايت)`,
        ),
      );
    }
    const key = `books/${randomUUID()}.pdf`;
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
  ): Promise<{ url: string; key: string; name: string; type: string; size: number }> {
    if (!file) {
      throw new BadRequestException(biBody('No file provided', 'لم يتم توفير أي ملف'));
    }
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException(
        biBody(`Unsupported file type: ${file.mimetype}`, `نوع ملف غير مدعوم: ${file.mimetype}`),
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
    });
    return {
      url: stored.url,
      key: stored.path,
      name: file.originalname,
      type: logicalType(file.mimetype),
      size: stored.size,
    };
  }
}
