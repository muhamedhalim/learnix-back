import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';
import {
  CertificationEntryDto,
  EducationEntryDto,
  PortfolioItemDto,
  ProfessionalLinkDto,
  ValidateNestedArray,
  WorkExperienceEntryDto,
} from './application-profile-items.dto';

/**
 * Every field is optional: a draft is filled in incrementally (PATCH-style),
 * and `POST /marketplace/applications` accepts the same shape for an
 * initial draft. `InstructorApplicationService.submit()` is what actually
 * enforces the FR-011 mandatory set, at submission time — not here.
 */
export class UpdateInstructorApplicationDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  display_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  photo_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  headline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  headline_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  bio_ar?: string;

  @IsOptional()
  @IsInt()
  @Min(0, { message: bi('years_of_experience cannot be negative', 'لا يمكن أن تكون سنوات الخبرة سالبة') })
  @Max(80)
  years_of_experience?: number;

  @ValidateNestedArray(EducationEntryDto, 20)
  education?: EducationEntryDto[];

  @ValidateNestedArray(CertificationEntryDto, 20)
  certifications?: CertificationEntryDto[];

  @ValidateNestedArray(WorkExperienceEntryDto, 20)
  work_experience?: WorkExperienceEntryDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  specializations?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  intended_category_ids?: string[];

  @ValidateNestedArray(PortfolioItemDto, 20)
  portfolio_items?: PortfolioItemDto[];

  @ValidateNestedArray(ProfessionalLinkDto, 10)
  professional_links?: ProfessionalLinkDto[];
}
