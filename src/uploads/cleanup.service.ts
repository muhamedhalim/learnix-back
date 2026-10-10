import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { FEATURE_FLAGS, isFeatureEnabled } from '../config/feature-flags';
import { User } from '../users/entities/user.entity';
import { CronSingleRunner } from '../common/utils/cron-lock.util';

/**
 * CleanupService
 *
 * Automated file cleanup service that runs weekly to remove orphaned files
 * from the uploads directory. Orphaned files are files that exist on disk but
 * are not referenced in the database.
 *
 * This prevents storage bloat from failed uploads, deleted users,
 * or other edge cases where files remain after database records are removed.
 *
 * TODO: Add cleanup for other entities as we build them:
 * - Lesson thumbnails
 * - Book covers
 * - Exam question images
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);
  private readonly uploadDir: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') ?? './uploads';
  }

  /**
   * Scheduled cleanup job - runs every Sunday at 2 AM
   * Cron format: '0 2 * * 0' (minute hour day month weekday)
   */
  @Cron('0 2 * * 0', {
    name: 'file-cleanup',
    timeZone: 'UTC',
  })
  @CronSingleRunner('uploads.weekly_cleanup')
  public async performWeeklyCleanup(): Promise<void> {
    // DESTRUCTIVE: this deletes files from the configured storage. Enabled
    // unless ENABLE_FILE_CLEANUP is exactly "false", so production behaviour is
    // unchanged; the flag exists so an environment whose storage credentials
    // are not yet confirmed isolated can be stood up without risking deletion.
    if (!isFeatureEnabled(FEATURE_FLAGS.FILE_CLEANUP)) {
      this.logger.log('Weekly file cleanup skipped: ENABLE_FILE_CLEANUP=false.');
      return;
    }

    this.logger.log('Starting weekly file cleanup job...');

    const startTime = Date.now();
    let totalOrphaned = 0;
    let totalDeleted = 0;
    let totalErrors = 0;

    try {
      // Cleanup profiles folder
      const profilesResult = await this.cleanupProfilesFolder();
      totalOrphaned += profilesResult.orphaned;
      totalDeleted += profilesResult.deleted;
      totalErrors += profilesResult.errors;

      const duration = Date.now() - startTime;

      this.logger.log(
        `Weekly cleanup completed - Duration: ${String(duration)}ms, Orphaned: ${String(totalOrphaned)}, Deleted: ${String(totalDeleted)}, Errors: ${String(totalErrors)}`,
      );
    } catch (error) {
      this.logger.error(
        'Weekly cleanup failed',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Manual cleanup trigger - can be called programmatically if needed
   */
  public async triggerManualCleanup(): Promise<{
    success: boolean;
    message: string;
    stats: {
      totalOrphaned: number;
      totalDeleted: number;
      totalErrors: number;
      duration: number;
    };
  }> {
    this.logger.log('Manual cleanup triggered');

    const startTime = Date.now();
    let totalOrphaned = 0;
    let totalDeleted = 0;
    let totalErrors = 0;

    try {
      const profilesResult = await this.cleanupProfilesFolder();
      totalOrphaned += profilesResult.orphaned;
      totalDeleted += profilesResult.deleted;
      totalErrors += profilesResult.errors;

      const duration = Date.now() - startTime;

      return {
        success: true,
        message: 'Manual cleanup completed successfully',
        stats: {
          totalOrphaned,
          totalDeleted,
          totalErrors,
          duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      return {
        success: false,
        message:
          error instanceof Error ? error.message : 'Manual cleanup failed',
        stats: {
          totalOrphaned,
          totalDeleted,
          totalErrors,
          duration,
        },
      };
    }
  }

  /**
   * Clean up orphaned files in the profiles folder
   */
  private async cleanupProfilesFolder(): Promise<{
    orphaned: number;
    deleted: number;
    errors: number;
  }> {
    this.logger.log('Scanning profiles folder for orphaned files...');

    const folderPath = join(this.uploadDir, 'profiles');
    let orphanedCount = 0;
    let deletedCount = 0;
    let errorCount = 0;

    try {
      // Get all files in folder
      const files = (await Reflect.apply(fs.readdir, fs, [
        folderPath,
      ])) as string[];

      if (files.length === 0) {
        this.logger.log('No files found in profiles folder');
        return { orphaned: 0, deleted: 0, errors: 0 };
      }

      // Get all profile picture URLs from database
      const users = await this.userRepository.find({
        select: ['profile_picture_url'],
      });
      const referencedFilenames = new Set<string>();

      // Extract filenames from URLs
      users.forEach((user) => {
        if (
          user.profile_picture_url !== null &&
          user.profile_picture_url !== ''
        ) {
          const filename = user.profile_picture_url.split('/').pop();
          if (filename !== undefined && filename !== '') {
            referencedFilenames.add(filename);
          }
        }
      });

      this.logger.log(
        `Found ${String(files.length)} files on disk, ${String(referencedFilenames.size)} referenced in database`,
      );

      // Check each file
      for (const file of files) {
        if (file === '.gitkeep') {
          continue;
        }

        if (!referencedFilenames.has(file)) {
          orphanedCount++;
          this.logger.warn(`Orphaned file detected: profiles/${file}`);

          // Delete orphaned file
          try {
            await Reflect.apply(fs.unlink, fs, [join(folderPath, file)]);
            deletedCount++;
            this.logger.log(`Deleted orphaned file: profiles/${file}`);
          } catch (error) {
            errorCount++;
            this.logger.error(
              `Failed to delete orphaned file: profiles/${file}`,
              error,
            );
          }
        }
      }

      this.logger.log(
        `Cleanup profiles - Orphaned: ${String(orphanedCount)}, Deleted: ${String(deletedCount)}, Errors: ${String(errorCount)}`,
      );

      return {
        orphaned: orphanedCount,
        deleted: deletedCount,
        errors: errorCount,
      };
    } catch (error) {
      this.logger.error('Failed to cleanup profiles folder', error);
      return {
        orphaned: orphanedCount,
        deleted: deletedCount,
        errors: errorCount + 1,
      };
    }
  }
}
