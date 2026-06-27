import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * DTO for bulk attendance code generation request
 */
export class BulkAttendanceCodesDto {
  @ApiProperty({
    description: 'Lesson ID to generate codes for',
    example: 'uuid-here',
  })
  @IsUUID()
  public lesson_id!: string;

  @ApiProperty({
    description: 'Price for each code',
    example: 100,
  })
  @IsNumber()
  @Min(0)
  public price!: number;

  @ApiProperty({
    description: 'Number of codes to generate (1-1000)',
    example: 50,
    minimum: 1,
    maximum: 1000,
  })
  @Transform(({ value }): number => Number.parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(1000)
  public codes_count!: number;

  @ApiPropertyOptional({
    description: 'Expiration date for all generated codes (ISO 8601)',
    example: '2025-12-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  public expires_at?: string;

  @ApiPropertyOptional({
    description: 'Usage limit per code (default: 1)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Transform(({ value }): number => Number.parseInt(String(value), 10))
  @IsInt()
  @Min(1)
  @Max(100)
  public quantity_per_code?: number;
}

/**
 * Response DTO for bulk attendance code generation
 */
export class BulkAttendanceCodesResultDto {
  @ApiProperty({ description: 'Lesson ID codes were generated for' })
  public lesson_id!: string;

  @ApiProperty({ description: 'Total codes requested' })
  public codes_requested!: number;

  @ApiProperty({ description: 'Codes successfully generated' })
  public codes_generated!: number;

  @ApiProperty({
    description: 'Array of generated codes',
    type: [String],
    example: ['ABC123', 'DEF456', 'GHI789'],
  })
  public codes!: string[];

  @ApiProperty({ description: 'Price per code' })
  public price!: number;

  @ApiPropertyOptional({ description: 'Expiration date if set' })
  public expires_at?: Date | undefined;

  @ApiProperty({ description: 'Usage limit per code' })
  public quantity_per_code!: number;

  @ApiProperty({
    description: 'Generation completed at',
  })
  public completed_at!: Date;
}
