import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { UserRole } from '../users/entities/user-role.enum';
import type {
  FileDetailsDto,
  FileListResponseDto,
  FileReferenceDto,
  FileUsageDto,
} from './dto/file-details.dto';
import type { FileListQueryDto } from './dto/file-list-query.dto';
import type { UploadFolderType } from './entities/uploaded-file.entity';
import { UploadedFile } from './entities/uploaded-file.entity';
import { UploadService } from './upload.service';

interface FileListRawRow {
  id: string;
  filename: string;
  original_filename: string;
  folder: UploadFolderType;
  mime_type: string;
  size: string | number;
  created_at: Date | string;
  used_in: FileReferenceDto[] | string | null;
}

interface FileUsageRawRow {
  filename: string;
  used_in: FileReferenceDto[] | string | null;
}

// Lesson videos are no longer uploaded files: `lessons.video_url` was dropped by the RetireBunnyVideo
// migration and playback goes through `video_asset_id`, so no `video_url` reference is selected here.
// Usage is intentionally aggregated by PostgreSQL. This keeps both the list and
// single-file usage paths at a constant number of database round trips.
const FILE_USAGE_SELECT = `
  COALESCE(
    (
      SELECT jsonb_agg(
        usage_reference.reference
        ORDER BY usage_reference.entity_type, usage_reference.entity_id, usage_reference.field_name
      )
      FROM (
        SELECT
          'lesson' AS entity_type,
          lesson.id::text AS entity_id,
          'thumbnail' AS field_name,
          jsonb_build_object(
            'entityType', 'lesson',
            'entityId', lesson.id,
            'field', 'thumbnail',
            'entityTitle', lesson.title
          ) AS reference
        FROM lessons lesson
        WHERE lesson.deleted_at IS NULL
          AND POSITION(uploaded_file.filename IN lesson.thumbnail) > 0

        UNION ALL

        SELECT
          'book',
          book.id::text,
          'book_file',
          jsonb_build_object(
            'entityType', 'book',
            'entityId', book.id,
            'field', 'book_file',
            'entityTitle', book.title
          )
        FROM books book
        WHERE book.deleted_at IS NULL
          AND POSITION(uploaded_file.filename IN book.book_file) > 0

        UNION ALL

        SELECT
          'book',
          book.id::text,
          'cover_image',
          jsonb_build_object(
            'entityType', 'book',
            'entityId', book.id,
            'field', 'cover_image',
            'entityTitle', book.title
          )
        FROM books book
        WHERE book.deleted_at IS NULL
          AND POSITION(uploaded_file.filename IN book.cover_image) > 0

        UNION ALL

        SELECT
          'user',
          app_user.id::text,
          CASE
            WHEN POSITION(uploaded_file.filename IN app_user.profile_picture_url) > 0
              THEN 'profile_picture_url'
            ELSE 'profile_picture_thumbnail_url'
          END,
          jsonb_build_object(
            'entityType', 'user',
            'entityId', app_user.id,
            'field', CASE
              WHEN POSITION(uploaded_file.filename IN app_user.profile_picture_url) > 0
                THEN 'profile_picture_url'
              ELSE 'profile_picture_thumbnail_url'
            END,
            'entityTitle', app_user.name
          )
        FROM users app_user
        WHERE app_user.deleted_at IS NULL
          AND (
            POSITION(uploaded_file.filename IN app_user.profile_picture_url) > 0
            OR POSITION(uploaded_file.filename IN app_user.profile_picture_thumbnail_url) > 0
          )
      ) usage_reference
    ),
    '[]'::jsonb
  )
`;

function parseFileReferences(value: FileListRawRow['used_in']): FileReferenceDto[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as FileReferenceDto[]) : [];
  }

  return [];
}

@Injectable()
export class FileManagementService {
  private readonly logger = new Logger(FileManagementService.name);

  constructor(
    @InjectRepository(UploadedFile)
    private readonly uploadedFilesRepository: Repository<UploadedFile>,
    private readonly uploadService: UploadService,
  ) {}

  /**
   * Track a new file upload in the database
   */
  public async trackUpload(params: {
    filename: string;
    originalFilename: string;
    folder: UploadFolderType;
    mimeType: string;
    size: number;
    uploaderId: string | null;
  }): Promise<UploadedFile> {
    const file = this.uploadedFilesRepository.create({
      filename: params.filename,
      original_filename: params.originalFilename,
      folder: params.folder,
      mime_type: params.mimeType,
      size: params.size,
      uploader_id: params.uploaderId,
    });

    const saved = await this.uploadedFilesRepository.save(file);
    this.logger.log(`File tracked: ${params.filename} by user ${params.uploaderId ?? 'anonymous'}`);
    return saved;
  }

  /**
   * Return one bounded page using exactly two queries: one count and one list
   * query. Usage references are aggregated in the list query, never per file.
   */
  public async getUserFiles(userId: string, query: FileListQueryDto): Promise<FileListResponseDto> {
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;

    const baseQuery = this.uploadedFilesRepository
      .createQueryBuilder('uploaded_file')
      .where('uploaded_file.uploader_id = :userId', { userId })
      .andWhere('uploaded_file.deleted_at IS NULL');

    if (query.folder !== undefined) {
      baseQuery.andWhere('uploaded_file.folder = :folder', {
        folder: query.folder,
      });
    }

    if (query.search !== undefined && query.search !== '') {
      baseQuery.andWhere(
        '(uploaded_file.filename ILIKE :search OR uploaded_file.original_filename ILIKE :search)',
        { search: `%${query.search}%` },
      );
    }

    const countQuery = baseQuery.clone();
    const pageIdsQuery = baseQuery
      .clone()
      .select('uploaded_file.id')
      .orderBy('uploaded_file.created_at', 'DESC')
      .addOrderBy('uploaded_file.id', 'DESC')
      .offset(offset)
      .limit(limit);

    // The page is selected before evaluating the correlated usage projection.
    // Without this subquery PostgreSQL may evaluate usage for every discarded
    // offset row, making deep pages progressively slower.
    const listQuery = this.uploadedFilesRepository
      .createQueryBuilder('uploaded_file')
      .select('uploaded_file.id', 'id')
      .addSelect('uploaded_file.filename', 'filename')
      .addSelect('uploaded_file.original_filename', 'original_filename')
      .addSelect('uploaded_file.folder', 'folder')
      .addSelect('uploaded_file.mime_type', 'mime_type')
      .addSelect('uploaded_file.size', 'size')
      .addSelect('uploaded_file.created_at', 'created_at')
      .addSelect(FILE_USAGE_SELECT, 'used_in')
      .where(`uploaded_file.id IN (${pageIdsQuery.getQuery()})`)
      .setParameters(pageIdsQuery.getParameters())
      .orderBy('uploaded_file.created_at', 'DESC')
      .addOrderBy('uploaded_file.id', 'DESC');

    const [total, rows] = await Promise.all([
      countQuery.getCount(),
      listQuery.getRawMany<FileListRawRow>(),
    ]);

    const data: FileDetailsDto[] = rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      originalFilename: row.original_filename,
      folder: row.folder,
      mimeType: row.mime_type,
      size: Number(row.size),
      uploadedAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      usedIn: parseFileReferences(row.used_in),
    }));

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Check where a file is being used across the platform
   */
  public async getFileUsage(filename: string): Promise<FileUsageDto> {
    const row = await this.uploadedFilesRepository
      .createQueryBuilder('uploaded_file')
      .select('uploaded_file.filename', 'filename')
      .addSelect(FILE_USAGE_SELECT, 'used_in')
      .where('uploaded_file.filename = :filename', { filename })
      .getRawOne<FileUsageRawRow>();

    const references = parseFileReferences(row?.used_in ?? null);

    return {
      filename,
      isInUse: references.length > 0,
      usedIn: references,
    };
  }

  /**
   * Delete a file (soft delete if in use without force, hard delete otherwise)
   */
  public async deleteFile(
    userId: string,
    userRole: UserRole,
    fileId: string,
    force = false,
  ): Promise<void> {
    const file = await this.uploadedFilesRepository.findOne({
      where: { id: fileId, deleted_at: IsNull() },
    });

    if (file === null) {
      throw new NotFoundException(biBody('File not found', 'الملف غير موجود'));
    }

    // Check ownership (only uploader or admin can delete)
    if (file.uploader_id !== userId && userRole !== UserRole.ADMIN) {
      throw new ForbiddenException(
        biBody('You can only delete your own files', 'يمكنك فقط حذف ملفاتك الخاصة'),
      );
    }

    // Check file usage
    const usage = await this.getFileUsage(file.filename);

    if (usage.isInUse && !force) {
      throw new ConflictException({
        message: 'File is currently in use and cannot be deleted',
        usedIn: usage.usedIn,
      });
    }

    // Soft delete the record
    file.deleted_at = new Date();
    await this.uploadedFilesRepository.save(file);

    this.logger.log(
      `File soft-deleted: ${file.filename} by user ${userId} (force: ${String(force)})`,
    );

    // If force delete and not in use, also delete physical file
    if (!usage.isInUse) {
      try {
        await this.uploadService.deleteFile(file.folder, file.filename);
        this.logger.log(`Physical file deleted: ${file.folder}/${file.filename}`);
      } catch (error) {
        this.logger.warn(
          `Failed to delete physical file: ${file.folder}/${file.filename} - ${String(error)}`,
        );
      }
    }
  }

  /**
   * Get a specific file by ID
   */
  public async getFileById(fileId: string): Promise<UploadedFile | null> {
    return await this.uploadedFilesRepository.findOne({
      where: { id: fileId, deleted_at: IsNull() },
    });
  }

  /**
   * Get file by filename
   */
  public async getFileByFilename(filename: string): Promise<UploadedFile | null> {
    return await this.uploadedFilesRepository.findOne({
      where: { filename, deleted_at: IsNull() },
    });
  }
}
