import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

/** FR-227 – FR-231 — the shared shape behind `/sales` (optionally narrowed to one instructor or one course) and `/payouts/report`. */
export class ReportPeriodQueryDto {
  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsUUID('4')
  instructorId?: string;

  @IsOptional()
  @IsUUID('4')
  courseId?: string;
}

export class InstructorRosterQueryDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class AdminLedgerQueryDto {
  @IsOptional()
  @IsUUID('4')
  instructorId?: string;

  @IsOptional()
  @IsString()
  entry_type?: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
