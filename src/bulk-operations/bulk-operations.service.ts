import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { AttendanceCodesService } from '../attendance-codes/attendance-codes.service';
import { AttendanceCodeType } from '../attendance-codes/entities';
import { Lesson } from '../lessons/entities/lesson.entity';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
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
import * as Papa from 'papaparse';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';

/**
 * Interface for parsed CSV row
 */
interface ParsedStudentRow {
  name?: string;
  email?: string;
  phone?: string;
  parent_phone?: string;
  grade_level?: string;
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
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Parse and validate CSV file for student import
   * Returns preview without actually importing
   */
  public async previewStudentImport(
    csvContent: string,
  ): Promise<BulkImportPreviewDto> {
    const rows = this.parseCsv(csvContent);

    const validRows: StudentImportRowDto[] = [];
    const validationErrors: Array<{
      row: number;
      email?: string;
      errors: string[];
    }> = [];

    // Get existing emails for duplicate check
    const existingEmails = new Set(
      (await this.usersRepository.find({ select: ['email'] })).map((u) =>
        u.email.toLowerCase(),
      ),
    );

    let duplicateCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) {
        continue;
      }

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
          grade_level: row.grade_level,
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

    // Get existing emails for duplicate check

    const existingEmails = new Set(
      (await this.usersRepository.find({ select: ['email'] })).map((u) =>
        u.email.toLowerCase(),
      ),
    );

    // Process in batches of 50 for transaction efficiency

    const batchSize = 50;

    for (
      let batchStart = 0;
      batchStart < rows.length;
      batchStart += batchSize
    ) {
      const batch = rows.slice(batchStart, batchStart + batchSize);

      await this.dataSource.transaction(async (manager) => {
        for (let i = 0; i < batch.length; i++) {
          const row = batch[i];

          if (row === undefined) {
            continue;
          }

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

    skipped?: boolean;

    error?: { row: number; email?: string; errors: string[] };
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
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

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

      parent_phone:
        typeof row.parent_phone === 'string' && row.parent_phone !== ''
          ? row.parent_phone
          : null,

      role: UserRole.STUDENT,

      status: UserStatus.APPROVED,

      is_active: true,
    });

    const savedUser = await manager.save(User, user);

    const profile = manager.create(StudentProfile, {
      user_id: savedUser.id,

      grade_level:
        typeof row.grade_level === 'string' && row.grade_level !== ''
          ? row.grade_level
          : null,
    });

    await manager.save(StudentProfile, profile);
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

    const targetedUserIds = [...dto.user_ids];

    // Don't allow admins to bulk action themselves
    if (targetedUserIds.includes(adminId)) {
      results.errors.push({
        user_id: adminId,
        error: 'Cannot perform bulk action on yourself',
      });
      results.failed_count++;
      // Create a new array without the adminId to avoid no-param-reassign
      const filteredIds = targetedUserIds.filter((id) => id !== adminId);
      // We need to use these filteredIds for the database query
      const users = await this.usersRepository.find({
        where: {
          id: In(filteredIds),
          deleted_at: IsNull(),
        },
      });
      return await this.processBulkAction(
        users,
        dto,
        results,
        filteredIds,
        adminId,
      );
    }

    // Fetch all users
    const users = await this.usersRepository.find({
      where: {
        id: In(targetedUserIds),
        deleted_at: IsNull(),
      },
    });

    return await this.processBulkAction(
      users,
      dto,
      results,
      targetedUserIds,
      adminId,
    );
  }

  /**
   * Helper method to process bulk actions after filtering
   */
  private async processBulkAction(
    users: User[],
    dto: BulkUserActionDto,
    initialResults: BulkUserActionResultDto,
    targetedUserIds: string[],
    adminId: string,
  ): Promise<BulkUserActionResultDto> {
    const results: BulkUserActionResultDto = {
      action: initialResults.action,
      total_targeted: initialResults.total_targeted,
      success_count: initialResults.success_count,
      failed_count: initialResults.failed_count,
      skipped_count: initialResults.skipped_count,
      errors: [...initialResults.errors],
      completed_at: initialResults.completed_at,
    };
    const foundIds = new Set(users.map((u) => u.id));

    // Check for not found users
    for (const userId of targetedUserIds) {
      if (!foundIds.has(userId)) {
        results.errors.push({
          user_id: userId,
          error: 'User not found',
        });
        results.failed_count++;
      }
    }

    // Process each user
    for (const user of users) {
      try {
        switch (dto.action) {
          case BulkUserAction.SUSPEND:
            if (!user.is_active) {
              results.skipped_count++;
              continue;
            }
            user.is_active = false;
            break;

          case BulkUserAction.ACTIVATE:
            if (user.is_active) {
              results.skipped_count++;
              continue;
            }
            user.is_active = true;
            break;

          case BulkUserAction.DELETE:
            // Soft delete
            user.deleted_at = new Date();
            user.is_active = false;
            break;
        }

        await this.usersRepository.save(user);
        results.success_count++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        results.errors.push({
          user_id: user.id,
          error: errorMessage,
        });
        results.failed_count++;
      }
    }

    results.completed_at = new Date();

    this.logger.log(
      `Bulk user action '${dto.action}' completed by admin ${adminId}: ` +
        `${results.success_count} success, ${results.failed_count} failed, ${results.skipped_count} skipped`,
    );

    return results;
  }

  /**
   * Send bulk notifications to filtered students
   */
  public async sendBulkNotifications(
    dto: BulkNotificationDto,
    adminId: string,
  ): Promise<BulkNotificationResultDto> {
    const startTime = new Date();

    // Build query for students
    const queryBuilder = this.usersRepository
      .createQueryBuilder('user')
      .leftJoin('student_profiles', 'profile', 'profile.user_id = user.id')
      .where('user.role = :role', { role: UserRole.STUDENT })
      .andWhere('user.is_active = true')
      .andWhere('user.deleted_at IS NULL')
      .andWhere('user.parent_phone IS NOT NULL');

    // Apply filters
    if (
      typeof dto.filter.grade_level === 'string' &&
      dto.filter.grade_level !== ''
    ) {
      queryBuilder.andWhere('profile.grade_level = :gradeLevel', {
        gradeLevel: dto.filter.grade_level,
      });
    }

    if (typeof dto.filter.status === 'string' && dto.filter.status !== 'all') {
      if (dto.filter.status === 'active') {
        queryBuilder.andWhere('user.is_active = true');
      } else {
        queryBuilder.andWhere('user.is_active = false');
      }
    }

    if (
      Array.isArray(dto.filter.student_ids) &&
      dto.filter.student_ids.length > 0
    ) {
      queryBuilder.andWhere('user.id IN (:...studentIds)', {
        studentIds: dto.filter.student_ids,
      });
    }

    const students = await queryBuilder
      .select(['user.id', 'user.parent_phone'])
      .getMany();

    const results: BulkNotificationResultDto = {
      total_queued: students.length,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 0,
      status: 'processing',
      started_at: startTime,
    };

    // Send notifications synchronously (for small batches)
    // For large batches (>100), this should be queued
    for (const student of students) {
      if (
        typeof student.parent_phone !== 'string' ||
        student.parent_phone === ''
      ) {
        results.skipped_count++;
        continue;
      }

      try {
        await this.notificationsService.create({
          user_id: student.id,
          type: NotificationType.CUSTOM,
          title: dto.title ?? 'Notification',
          message: dto.message,
          send_sms: true,
        });
        results.sent_count++;
      } catch {
        results.failed_count++;
      }
    }

    results.status = 'completed';
    results.completed_at = new Date();

    this.logger.log(
      `Bulk notification sent by admin ${adminId}: ` +
        `${results.sent_count} sent, ${results.failed_count} failed, ${results.skipped_count} skipped`,
    );

    return results;
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
      throw new NotFoundException('Lesson not found');
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
      throw new BadRequestException(`CSV parsing errors: ${errorMessages}`);
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
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
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
    if (
      typeof row.parent_phone === 'string' &&
      row.parent_phone.trim() !== ''
    ) {
      if (!/^01[0125]\d{8}$/.test(row.parent_phone)) {
        errors.push('Parent phone must be Egyptian format (01XXXXXXXXX)');
      }
    }

    if (typeof row.grade_level === 'string' && row.grade_level.trim() !== '') {
      const grade = parseInt(row.grade_level, 10);

      if (isNaN(grade) || grade < 1 || grade > 12) {
        errors.push('Grade level must be between 1 and 12');
      }
    }
  }
}
