import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { CertificateStatus } from '../entities/certificate-status.enum';

/**
 * Certificate issuance (admin: any course; teacher: own courses only).
 * Recipients are either an explicit student list (single issuance = a
 * one-element list) or `allCompleted` — every purchaser at 100% progress.
 */
export class IssueCertificateDto {
  /** Back-compat single recipient; merged into `studentIds` by the controller. */
  @IsOptional()
  @IsUUID()
  public studentId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(500)
  public studentIds?: string[];

  @IsUUID()
  public packageId!: string;

  /** Must reference a PUBLISHED template; omitted = the course default. */
  @IsOptional()
  @IsUUID()
  public templateId?: string;

  /** Issue to every purchaser who completed the whole course. */
  @IsOptional()
  @IsBoolean()
  public allCompleted?: boolean;

  /** Admin/teacher override: issue even below 100% completion. */
  @IsOptional()
  @IsBoolean()
  public force?: boolean;
}

export class RevokeCertificateDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}

export class CertificateVisibilityDto {
  @IsBoolean()
  public is_public!: boolean;
}

export class CertificateListFilterDto {
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @StrictIntegerQuery({ max: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;

  @IsOptional()
  @IsEnum(CertificateStatus)
  public status?: CertificateStatus;
}

export class PublicCertificatesFilterDto {
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @StrictIntegerQuery({ max: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  public limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public search?: string;
}
