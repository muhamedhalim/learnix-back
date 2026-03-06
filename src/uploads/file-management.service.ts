import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { Book } from '../books/entities/book.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';

import type {
  FileDetailsDto,
  FileReferenceDto,
  FileUsageDto,
} from './dto/file-details.dto';
import type { UploadFolderType } from './entities/uploaded-file.entity';
import { UploadedFile } from './entities/uploaded-file.entity';
import { UploadService } from './upload.service';

@Injectable()
export class FileManagementService {
  private readonly logger = new Logger(FileManagementService.name);

  constructor(
    @InjectRepository(UploadedFile)
    private readonly uploadedFilesRepository: Repository<UploadedFile>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(Book)
    private readonly booksRepository: Repository<Book>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
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
    this.logger.log(
      `File tracked: ${params.filename} by user ${params.uploaderId ?? 'anonymous'}`,
    );
    return saved;
  }

  /**
   * Get all files uploaded by a specific user
   */
  public async getUserFiles(
    userId: string,
    folder?: UploadFolderType,
  ): Promise<FileDetailsDto[]> {
    const whereClause: {
      uploader_id: string;
      deleted_at: ReturnType<typeof IsNull>;
      folder?: UploadFolderType;
    } = {
      uploader_id: userId,
      deleted_at: IsNull(),
    };

    if (folder !== undefined) {
      whereClause.folder = folder;
    }

    const files = await this.uploadedFilesRepository.find({
      where: whereClause,
      order: { created_at: 'DESC' },
    });

    const filesWithUsage: FileDetailsDto[] = [];
    for (const file of files) {
      const usage = await this.getFileUsage(file.filename);
      filesWithUsage.push({
        id: file.id,
        filename: file.filename,
        originalFilename: file.original_filename,
        folder: file.folder,
        mimeType: file.mime_type,
        size: file.size,
        uploadedAt: file.created_at,
        usedIn: usage.usedIn,
      });
    }

    return filesWithUsage;
  }

  /**
   * Check where a file is being used across the platform
   */
  public async getFileUsage(filename: string): Promise<FileUsageDto> {
    const references: FileReferenceDto[] = [];

    // Check lessons (video_url, thumbnail_url)
    const lessonsWithVideo = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .where('lesson.deleted_at IS NULL')
      .andWhere('lesson.video_url LIKE :pattern', { pattern: `%${filename}%` })
      .select(['lesson.id', 'lesson.title'])
      .getMany();

    for (const lesson of lessonsWithVideo) {
      references.push({
        entityType: 'lesson',
        entityId: lesson.id,
        field: 'video_url',
        entityTitle: lesson.title,
      });
    }

    const lessonsWithThumbnail = await this.lessonsRepository
      .createQueryBuilder('lesson')
      .where('lesson.deleted_at IS NULL')
      .andWhere('lesson.thumbnail_url LIKE :pattern', {
        pattern: `%${filename}%`,
      })
      .select(['lesson.id', 'lesson.title'])
      .getMany();

    for (const lesson of lessonsWithThumbnail) {
      references.push({
        entityType: 'lesson',
        entityId: lesson.id,
        field: 'thumbnail_url',
        entityTitle: lesson.title,
      });
    }

    // Check books (pdf_url, cover_image)
    const booksWithPdf = await this.booksRepository
      .createQueryBuilder('book')
      .where('book.deleted_at IS NULL')
      .andWhere('book.pdf_url LIKE :pattern', { pattern: `%${filename}%` })
      .select(['book.id', 'book.title'])
      .getMany();

    for (const book of booksWithPdf) {
      references.push({
        entityType: 'book',
        entityId: book.id,
        field: 'pdf_url',
        entityTitle: book.title,
      });
    }

    const booksWithCover = await this.booksRepository
      .createQueryBuilder('book')
      .where('book.deleted_at IS NULL')
      .andWhere('book.cover_image LIKE :pattern', { pattern: `%${filename}%` })
      .select(['book.id', 'book.title'])
      .getMany();

    for (const book of booksWithCover) {
      references.push({
        entityType: 'book',
        entityId: book.id,
        field: 'cover_image',
        entityTitle: book.title,
      });
    }

    // Check users (profile_picture_url, profile_picture_thumbnail_url)
    const usersWithProfile = await this.usersRepository
      .createQueryBuilder('user')
      .where('user.deleted_at IS NULL')
      .andWhere(
        '(user.profile_picture_url LIKE :pattern OR user.profile_picture_thumbnail_url LIKE :pattern)',
        { pattern: `%${filename}%` },
      )
      .select(['user.id', 'user.name'])
      .getMany();

    for (const user of usersWithProfile) {
      references.push({
        entityType: 'user',
        entityId: user.id,
        field: 'profile_picture_url',
        entityTitle: user.name,
      });
    }

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
      throw new NotFoundException('File not found');
    }

    // Check ownership (only uploader or admin can delete)
    if (file.uploader_id !== userId && userRole !== UserRole.ADMIN) {
      throw new ForbiddenException('You can only delete your own files');
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
        this.logger.log(
          `Physical file deleted: ${file.folder}/${file.filename}`,
        );
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
  public async getFileByFilename(
    filename: string,
  ): Promise<UploadedFile | null> {
    return await this.uploadedFilesRepository.findOne({
      where: { filename, deleted_at: IsNull() },
    });
  }
}
