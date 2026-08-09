import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Queue } from 'bullmq';
import * as Papa from 'papaparse';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

import { AttendanceCodesService } from '../attendance-codes/attendance-codes.service';
import { AttendanceCodeType } from '../attendance-codes/entities';
import { Lesson } from '../lessons/entities/lesson.entity';
import { toE164 } from '../common/utils/phone.util';
import { GuardiansService } from '../guardians/guardians.service';
import { biBody } from '../i18n/error-translator.util';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import {
  BulkAttendanceCodesDto,
  BulkAttendanceCodesResultDto,
  BulkImportPreviewDto,
  BulkImportResultDto,
  BulkNotificationDto,
  BulkNotificationResultDto,
  BulkUserAction,
  BulkUserActionDto,
  BulkUserActionResultDto,
  StudentImportRowDto,
} from './dto';

/**
 * Interface for parsed CSV row
 */
interface ParsedStudentRow {
  name?: string;
  email?: string;
  phone?: string;
  parent_phone?: string;
}

@Injectable()
export class BulkOperationsService {
  private readonly logger = new Logger(BulkOperationsService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    private readonly dataSource: DataSource,
    private readonly attendanceCodesService: AttendanceCodesService,
    private readonly guardiansService: GuardiansService,
    @InjectQueue(QUEUE_NAMES.BULK_NOTIFICATIONS)
    private readonly bulkNotificationsQueue: Queue,
  ) {}

  /**
   * Parse and validate CSV file for student import
   * Returns preview without actually importing
   */
  public async previewStudentImport(csvContent: string): Promise<BulkImportPreviewDto> {
    const rows = this.parseCsv(csvContent);

    const validRows: StudentImportRowDto[] = [];
    const validationErrors: Array<{
      row: number;
      email?: string | undefined;
      errors: string[];
    }> = [];

    const existingEmails = await this.findExistingEmails(rows);

    let duplicateCount = 0;

    for (const [i, row] of rows.entries()) {
      const errors = this.validateStudentRow(row);
      const rowNumber = i + 2; // CSV row number (1-indexed, accounting for header)

      if (
        typeof row.email === 'string' &&
        row.email !== '' &&
        existingEmails.has(row.email.toLowerCase())
      ) {
        errors.push('Email already exists in database');
        duplicateCount++;
      }

      if (errors.length > 0) {
        validationErrors.push({
          row: rowNumber,
          email: row.email,
          errors,
        });
      } else {
        validRows.push({
          name: typeof row.name === 'string' ? row.name : '',
          email: typeof row.email === 'string' ? row.email : '',
          phone: typeof row.phone === 'string' ? row.phone : '',
          parent_phone: row.parent_phone,
        });
      }
    }

    return {
      total_rows: rows.length,
      valid_count: validRows.length,
      invalid_count: validationErrors.length,
      duplicate_count: duplicateCount,
      preview: validRows.slice(0, 10), // First 10 valid rows
      validation_errors: validationErrors.slice(0, 50), // First 50 errors
    };
  }

  /**

     * Import students from CSV file

     */

  public async importStudents(
    csvContent: string,

    adminId: string,
  ): Promise<BulkImportResultDto> {
    const rows = this.parseCsv(csvContent);

    const startTime = new Date();

    const results: BulkImportResultDto = {
      total_processed: rows.length,

      success_count: 0,

      failed_count: 0,

      skipped_count: 0,

      errors: [],

      completed_at: new Date(),
    };

    const existingEmails = await this.findExistingEmails(rows);

    // Process in batches of 50 for transaction efficiency

    const batchSize = 50;

    for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
      const batch = rows.slice(batchStart, batchStart + batchSize);

      await this.dataSource.transaction(async (manager) => {
        for (const [i, row] of batch.entries()) {
          const rowNumber = batchStart + i + 2; // CSV row number

          const rowResult = await this.processImportRow(
            row,

            rowNumber,

            manager,

            existingEmails,
          );

          if (rowResult.success) {
            results.success_count++;

            if (typeof row.email === 'string' && row.email !== '') {
              existingEmails.add(row.email.toLowerCase());
            }
          } else if (rowResult.skipped === true) {
            results.skipped_count++;
          } else {
            results.failed_count++;

            if (rowResult.error) {
              results.errors.push(rowResult.error);
            }
          }
        }
      });
    }

    results.completed_at = new Date();

    this.logger.log(
      `Bulk student import completed by admin ${adminId}: ` +
        `${results.success_count} success, ${results.failed_count} failed, ` +
        `${results.skipped_count} skipped (${Date.now() - startTime.getTime()}ms)`,
    );

    return results;
  }

  /**

     * Process a single row for student import

     */

  private async processImportRow(
    row: ParsedStudentRow,

    rowNumber: number,

    manager: EntityManager,

    existingEmails: Set<string>,
  ): Promise<{
    success: boolean;

    skipped?: boolean | undefined;

    error?: { row: number; email?: string | undefined; errors: string[] } | undefined;
  }> {
    try {
      // Validate row

      const errors = this.validateStudentRow(row);

      if (errors.length > 0) {
        return {
          success: false,

          error: {
            row: rowNumber,

            email: row.email,

            errors,
          },
        };
      }

      // Check for duplicate email

      if (
        typeof row.email === 'string' &&
        row.email !== '' &&
        existingEmails.has(row.email.toLowerCase())
      ) {
        return { success: false, skipped: true };
      }

      // Create user and profile

      await this.saveImportedStudent(row, manager);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        success: false,

        error: {
          row: rowNumber,

          email: row.email,

          errors: [errorMessage],
        },
      };
    }
  }

  /**

     * Create and save user and student profile

     */

  private async saveImportedStudent(
    row: ParsedStudentRow,

    manager: EntityManager,
  ): Promise<void> {
    const user = manager.create(User, {
      name: typeof row.name === 'string' ? row.name : '',

      email: typeof row.email === 'string' ? row.email.toLowerCase() : '',

      phone: typeof row.phone === 'string' ? row.phone : '',

      role: UserRole.STUDENT,

      status: UserStatus.APPROVED,

      is_active: true,
    });

    const savedUser = await manager.save(User, user);

    const profile = manager.create(StudentProfile, {
      user_id: savedUser.id,
    });

    await manager.save(StudentProfile, profile);

    // An imported parent phone is unproven, so the guardian lands UNVERIFIED and
    // receives nothing until an OTP is redeemed. Shares the caller's transaction
    // so a bad row rolls back the user, profile and guardian link together.
    if (typeof row.parent_phone === 'string' && row.parent_phone.trim() !== '') {
      await this.guardiansService.linkGuardianWith(manager, savedUser.id, {
        phone: row.parent_phone.trim(),
        is_primary: true,
      });
    }
  }

  /**

     * Perform bulk action on users (suspend, activate, delete)

  
   */
  public async performBulkUserAction(
    dto: BulkUserActionDto,
    adminId: string,
  ): Promise<BulkUserActionResultDto> {
    const results: BulkUserActionResultDto = {
      action: dto.action,
      total_targeted: dto.user_ids.length,
      success_count: 0,
      failed_count: 0,
      skipped_count: 0,
      errors: [],
      completed_at: new Date(),
    };

    const targetedUserIds = [...new Set(dto.user_ids)];

    if (targetedUserIds.includes(adminId)) {
      results.errors.push({
        user_id: adminId,
        error: 'Cannot perform bulk action on yourself',
      });
      results.failed_count++;
    }

    const actionableIds = targetedUserIds.filter((id) => id !== adminId);
    const users = await this.usersRepository.find({
      select: { id: true, is_active: true },
      where: {
        id: In(actionableIds),
        deleted_at: IsNull(),
      },
    });
    const foundIds = new Set(users.map((u) => u.id));

    for (const userId of actionableIds) {
      if (!foundIds.has(userId)) {
        results.errors.push({
          user_id: userId,
          error: 'User not found',
        });
        results.failed_count++;
      }
    }

    const usersToUpdate = users.filter((user) => {
      if (dto.action === BulkUserAction.SUSPEND) return user.is_active;
      if (dto.action === BulkUserAction.ACTIVATE) return !user.is_active;
      return true;
    });
    results.skipped_count = users.length - usersToUpdate.length;

    const idsToUpdate = usersToUpdate.map((user) => user.id);
    if (idsToUpdate.length > 0) {
      const update =
        dto.action === BulkUserAction.SUSPEND
          ? { is_active: false }
          : dto.action === BulkUserAction.ACTIVATE
            ? { is_active: true }
            : { deleted_at: new Date(), is_active: false };
      await this.usersRepository.update({ id: In(idsToUpdate), deleted_at: IsNull() }, update);
      results.success_count = idsToUpdate.length;
    }

    results.completed_at = new Date();

    this.logger.log(
      `Bulk user action '${dto.action}' completed by admin ${adminId}: ` +
        `${results.success_count} success, ${results.failed_count} failed, ${results.skipped_count} skipped`,
    );

    return results;
  }

  /**
   * Broadcast an in-app notification to filtered students.
   *
   * This used to also SMS each student's parent, because `NotificationType.CUSTOM`
   * unconditionally routed to the parent phone. That was never visible to the
   * admin composing the message, so it is gone: a broadcast is now in-app only.
   * A deliberate admin→guardian announcement belongs in the parent notification
   * pipeline as its own event type, with its own template and opt-out.
   */
  public async sendBulkNotifications(
    dto: BulkNotificationDto,
    adminId: string,
  ): Promise<BulkNotificationResultDto> {
    const startedAt = new Date();
    const totalQueued = await this.buildBulkNotificationRecipientQuery(dto).getCount();
    const job = await this.bulkNotificationsQueue.add(JOB_TYPES.NOTIFICATION.DELIVER_BULK, {
      dto,
      adminId,
    });

    const results: BulkNotificationResultDto = {
      total_queued: totalQueued,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 0,
      status: 'processing',
      started_at: startedAt,
      ...(job?.id === undefined ? {} : { job_id: String(job.id) }),
    };

    this.logger.log(`Bulk notification queued by admin ${adminId}: ${totalQueued} recipients`);

    return results;
  }

  private async findExistingEmails(rows: ParsedStudentRow[]): Promise<Set<string>> {
    const emails = [
      ...new Set(
        rows
          .map((row) => row.email?.trim().toLowerCase())
          .filter((email): email is string => email !== undefined && email !== ''),
      ),
    ];
    const existingEmails = new Set<string>();

    for (let start = 0; start < emails.length; start += 1000) {
      const batch = emails.slice(start, start + 1000);
      const matches = await this.usersRepository
        .createQueryBuilder('user')
        .select('LOWER(user.email)', 'email')
        .where('LOWER(user.email) IN (:...emails)', { emails: batch })
        .getRawMany<{ email: string }>();
      for (const match of matches) {
        existingEmails.add(match.email.toLowerCase());
      }
    }

    return existingEmails;
  }

  private buildBulkNotificationRecipientQuery(dto: BulkNotificationDto) {
    const queryBuilder = this.usersRepository
      .createQueryBuilder('user')
      .leftJoin('student_profiles', 'profile', 'profile.user_id = user.id')
      .where('user.role = :role', { role: UserRole.STUDENT })
      .andWhere('user.is_active = true')
      .andWhere('user.deleted_at IS NULL');

    if (typeof dto.filter.status === 'string' && dto.filter.status !== 'all') {
      queryBuilder.andWhere('user.is_active = :isActive', {
        isActive: dto.filter.status === 'active',
      });
    }
    if (Array.isArray(dto.filter.student_ids) && dto.filter.student_ids.length > 0) {
      queryBuilder.andWhere('user.id IN (:...studentIds)', {
        studentIds: dto.filter.student_ids,
      });
    }

    return queryBuilder;
  }

  /**
   * Generate bulk attendance codes for a lesson
   */
  public async generateBulkAttendanceCodes(
    dto: BulkAttendanceCodesDto,
    adminId: string,
  ): Promise<BulkAttendanceCodesResultDto> {
    // Verify lesson exists
    const lesson = await this.lessonsRepository.findOne({
      where: { id: dto.lesson_id, deleted_at: IsNull() },
    });

    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }

    // Use the attendance codes service to generate codes
    const codes = await this.attendanceCodesService.generateCodes(
      {
        type: AttendanceCodeType.LESSON,
        item_id: dto.lesson_id,
        count: dto.codes_count,
        expires_at:
          typeof dto.expires_at === 'string' && dto.expires_at !== ''
            ? dto.expires_at
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days default
      },
      adminId,
    );

    this.logger.log(
      `Bulk attendance codes generated by admin ${adminId}: ` +
        `${codes.length} codes for lesson ${dto.lesson_id}`,
    );

    return {
      lesson_id: dto.lesson_id,
      codes_requested: dto.codes_count,
      codes_generated: codes.length,
      codes: codes.map((c) => c.code),
      price: dto.price,
      expires_at:
        typeof dto.expires_at === 'string' && dto.expires_at !== ''
          ? new Date(dto.expires_at)
          : undefined,
      quantity_per_code: dto.quantity_per_code ?? 1,
      completed_at: new Date(),
    };
  }

  /**
   * Parse CSV content using papaparse
   */
  private parseCsv(csvContent: string): ParsedStudentRow[] {
    const result = Papa.parse<ParsedStudentRow>(csvContent, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (header: string) => header.toLowerCase().trim(),
    });

    if (result.errors.length > 0) {
      const errorMessages = result.errors
        .slice(0, 5)
        .map((e) => e.message)
        .join('; ');
      throw new BadRequestException(
        biBody(`CSV parsing errors: ${errorMessages}`, `أخطاء في تحليل ملف CSV: ${errorMessages}`),
      );
    }

    return result.data;
  }

  /**

     * Validate a student row from CSV

     */

  private validateStudentRow(row: ParsedStudentRow): string[] {
    const errors: string[] = [];

    this.validateRequiredFields(row, errors);

    this.validateOptionalFields(row, errors);

    return errors;
  }

  /**

     * Validate required fields for student import

     */

  private validateRequiredFields(
    row: ParsedStudentRow,

    errors: string[],
  ): void {
    if (typeof row.name !== 'string' || row.name.trim() === '') {
      errors.push('Name is required');
    }

    if (typeof row.email !== 'string' || row.email.trim() === '') {
      errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(row.email)) {
      errors.push('Invalid email format');
    }

    if (typeof row.phone !== 'string' || row.phone.trim() === '') {
      errors.push('Phone is required');
    } else if (!/^01[0125]\d{8}$/.test(row.phone)) {
      errors.push('Phone must be Egyptian format (01XXXXXXXXX)');
    }
  }

  /**

     * Validate optional fields for student import

     */

  private validateOptionalFields(
    row: ParsedStudentRow,

    errors: string[],
  ): void {
    if (typeof row.parent_phone === 'string' && row.parent_phone.trim() !== '') {
      // Same acceptance rule as every other entry point into the guardian
      // domain, so a CSV cannot smuggle in a number the API would reject.
      if (toE164(row.parent_phone) === null) {
        errors.push('Parent phone must be a valid Egyptian mobile (01XXXXXXXXX)');
      }
    }

  }
}
