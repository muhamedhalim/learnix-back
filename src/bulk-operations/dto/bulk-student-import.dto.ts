import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

/**
 * DTO for a single student row in CSV import
 */
export class StudentImportRowDto {
  @ApiProperty({ description: 'Student name', example: 'Ahmed Mohamed' })
  @IsString()
  public name!: string;

  @ApiProperty({
    description: 'Student email',
    example: 'student@example.com',
  })
  @IsEmail()
  public email!: string;

  @ApiProperty({
    description: 'Student phone (Egyptian format)',
    example: '01012345678',
  })
  @IsString()
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be Egyptian format (01XXXXXXXXX)',
      'يجب أن يكون رقم الهاتف بصيغة مصرية (01XXXXXXXXX)',
    ),
  })
  public phone!: string;

  @ApiPropertyOptional({
    description: 'Parent phone for notifications',
    example: '01098765432',
  })
  @IsOptional()
  @IsString()
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Parent phone must be Egyptian format (01XXXXXXXXX)',
      'يجب أن يكون رقم هاتف ولي الأمر بصيغة مصرية (01XXXXXXXXX)',
    ),
  })
  public parent_phone?: string | undefined;

}

/**
 * Response DTO for bulk import operation
 */
export class BulkImportResultDto {
  @ApiProperty({ description: 'Total rows processed' })
  public total_processed!: number;

  @ApiProperty({ description: 'Successfully imported count' })
  public success_count!: number;

  @ApiProperty({ description: 'Failed import count' })
  public failed_count!: number;

  @ApiProperty({ description: 'Skipped (duplicate) count' })
  public skipped_count!: number;

  @ApiProperty({
    description: 'Error details per row',
    type: [Object],
    example: [{ row: 5, email: 'invalid@', errors: ['Invalid email format'] }],
  })
  public errors!: Array<{
    row: number;
    email?: string | undefined;
    errors: string[];
  }>;

  @ApiProperty({
    description: 'Processing completed at',
    example: '2025-01-29T10:30:00Z',
  })
  public completed_at!: Date;
}

/**
 * DTO for validation preview (without actually importing)
 */
export class BulkImportPreviewDto {
  @ApiProperty({ description: 'Total rows in CSV' })
  public total_rows!: number;

  @ApiProperty({ description: 'Valid rows count' })
  public valid_count!: number;

  @ApiProperty({ description: 'Invalid rows count' })
  public invalid_count!: number;

  @ApiProperty({ description: 'Duplicate emails found' })
  public duplicate_count!: number;

  @ApiProperty({
    description: 'Preview of first 10 valid rows',
    type: [StudentImportRowDto],
  })
  public preview!: StudentImportRowDto[];

  @ApiProperty({
    description: 'Validation errors per row',
    type: [Object],
  })
  public validation_errors!: Array<{
    row: number;
    email?: string | undefined;
    errors: string[];
  }>;
}
