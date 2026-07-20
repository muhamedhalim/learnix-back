import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { GetUser } from '../common/decorators/get-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { biBody } from '../i18n/error-translator.util';
import { BulkOperationsService } from './bulk-operations.service';
import {
  BulkAttendanceCodesDto,
  BulkAttendanceCodesResultDto,
  BulkImportPreviewDto,
  BulkImportResultDto,
  BulkNotificationDto,
  BulkNotificationResultDto,
  BulkUserActionDto,
  BulkUserActionResultDto,
} from './dto';

const MAX_CSV_BYTES = 5 * 1024 * 1024;
const CSV_MIME_TYPES = new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel']);

function assertValidCsvUpload(file: Express.Multer.File): void {
  const name = file.originalname.toLowerCase();
  if (
    file.size > MAX_CSV_BYTES ||
    !name.endsWith('.csv') ||
    name.includes('..') ||
    name.includes('/') ||
    name.includes('\\') ||
    !CSV_MIME_TYPES.has(file.mimetype.toLowerCase()) ||
    file.buffer.subarray(0, Math.min(file.buffer.length, 4096)).includes(0)
  ) {
    throw new BadRequestException(biBody('Invalid CSV upload', 'Invalid CSV upload'));
  }
}

@ApiTags('Bulk Operations')
@Controller('admin')
@UseGuards(HybridAuthGuard, RolesGuard)
@ApiBearerAuth('JWT-auth')
export class BulkOperationsController {
  constructor(private readonly bulkOperationsService: BulkOperationsService) {}

  /**
   * Preview CSV import (validate without importing)
   */
  @Post('students/bulk-import/preview')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Preview bulk student import',
    description:
      'Validates CSV file and returns preview of what would be imported without actually importing.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'CSV file with columns: name, email, phone, parent_phone, grade_level',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Preview of import results',
    type: BulkImportPreviewDto,
  })
  public async previewStudentImport(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ data: BulkImportPreviewDto }> {
    if (!file) {
      throw new BadRequestException(biBody('No file uploaded', 'لم يتم رفع أي ملف'));
    }
    assertValidCsvUpload(file);

    const csvContent = file.buffer.toString('utf-8');
    const preview = await this.bulkOperationsService.previewStudentImport(csvContent);

    return { data: preview };
  }

  /**
   * Import students from CSV file
   */
  @Post('students/bulk-import')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Bulk import students from CSV',
    description:
      'Imports students from a CSV file. CSV must have columns: name, email, phone. ' +
      'Optional columns: parent_phone, grade_level. Duplicate emails are skipped.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'CSV file with columns: name, email, phone, parent_phone, grade_level',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Import results with success/failure counts',
    type: BulkImportResultDto,
  })
  public async importStudents(
    @GetUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ data: BulkImportResultDto }> {
    if (!file) {
      throw new BadRequestException(biBody('No file uploaded', 'لم يتم رفع أي ملف'));
    }
    assertValidCsvUpload(file);

    const csvContent = file.buffer.toString('utf-8');
    const result = await this.bulkOperationsService.importStudents(csvContent, user.userId);

    return { data: result };
  }

  /**
   * Perform bulk action on users
   */
  @Post('users/bulk-action')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Perform bulk action on users',
    description:
      'Perform bulk suspend, activate, or delete actions on multiple users. ' +
      'Delete is a soft delete that can be reversed.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Bulk action results',
    type: BulkUserActionResultDto,
  })
  public async bulkUserAction(
    @GetUser() user: JwtPayload,
    @Body() dto: BulkUserActionDto,
  ): Promise<{ data: BulkUserActionResultDto }> {
    const result = await this.bulkOperationsService.performBulkUserAction(dto, user.userId);

    return { data: result };
  }

  /**
   * Send bulk notifications to filtered students
   */
  @Post('notifications/bulk-send')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send bulk notifications',
    description:
      'Send SMS notifications to parents of filtered students. ' +
      'Students without parent phone numbers are skipped.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Notification send results',
    type: BulkNotificationResultDto,
  })
  public async sendBulkNotifications(
    @GetUser() user: JwtPayload,
    @Body() dto: BulkNotificationDto,
  ): Promise<{ data: BulkNotificationResultDto }> {
    const result = await this.bulkOperationsService.sendBulkNotifications(dto, user.userId);

    return { data: result };
  }

  /**
   * Generate bulk attendance codes for a lesson
   */
  @Post('attendance-codes/bulk')
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Generate bulk attendance codes',
    description:
      'Generate multiple attendance/purchase codes for a lesson. ' +
      'Maximum 1000 codes per request.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Generated codes',
    type: BulkAttendanceCodesResultDto,
  })
  public async generateBulkCodes(
    @GetUser() user: JwtPayload,
    @Body() dto: BulkAttendanceCodesDto,
  ): Promise<{ data: BulkAttendanceCodesResultDto }> {
    const result = await this.bulkOperationsService.generateBulkAttendanceCodes(dto, user.userId);

    return { data: result };
  }
}
