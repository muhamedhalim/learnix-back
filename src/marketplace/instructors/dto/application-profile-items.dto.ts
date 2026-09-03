import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';
import { IsSecureUrl } from '../../../common/validators/secure-url.validator';

const CURRENT_YEAR = new Date().getFullYear();
const EARLIEST_REASONABLE_YEAR = 1950;

export class EducationEntryDto {
  @IsString()
  @MaxLength(200)
  institution!: string;

  @IsString()
  @MaxLength(200)
  degree!: string;

  @IsString()
  @MaxLength(200)
  field!: string;

  @IsInt()
  @Min(EARLIEST_REASONABLE_YEAR)
  @Max(CURRENT_YEAR)
  start_year!: number;

  @IsOptional()
  @IsInt()
  @Min(EARLIEST_REASONABLE_YEAR)
  @Max(CURRENT_YEAR)
  end_year?: number | null;
}

export class CertificationEntryDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(200)
  issuer!: string;

  @IsInt()
  @Min(EARLIEST_REASONABLE_YEAR)
  @Max(CURRENT_YEAR)
  year!: number;

  @IsOptional()
  @IsSecureUrl({ message: bi('credential_url must be a secure URL', 'يجب أن يكون رابط الشهادة آمنًا') })
  credential_url?: string | null;
}

export class WorkExperienceEntryDto {
  @IsString()
  @MaxLength(200)
  company!: string;

  @IsString()
  @MaxLength(200)
  title!: string;

  @IsInt()
  @Min(EARLIEST_REASONABLE_YEAR)
  @Max(CURRENT_YEAR)
  start_year!: number;

  @IsOptional()
  @IsInt()
  @Min(EARLIEST_REASONABLE_YEAR)
  @Max(CURRENT_YEAR)
  end_year?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summary?: string | null;
}

export class PortfolioItemDto {
  @IsString()
  @MaxLength(200)
  title!: string;

  @IsSecureUrl({ message: bi('Portfolio url must be a secure URL', 'يجب أن يكون رابط معرض الأعمال آمنًا') })
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;
}

const PROFESSIONAL_LINK_KINDS = ['linkedin', 'website', 'github', 'other'] as const;

export class ProfessionalLinkDto {
  @IsIn(PROFESSIONAL_LINK_KINDS, {
    message: bi('kind must be one of linkedin, website, github, other', 'يجب أن يكون النوع أحد: linkedin أو website أو github أو other'),
  })
  kind!: (typeof PROFESSIONAL_LINK_KINDS)[number];

  @IsSecureUrl({ message: bi('Professional link url must be a secure URL', 'يجب أن يكون الرابط المهني آمنًا') })
  url!: string;
}

/**
 * Reusable nested-array validation for the four repeating collections
 * (education, certifications, work experience, portfolio items,
 * professional links): optional, capped, each element validated and
 * transformed to its class. Applying this ONE decorator is deliberately
 * the whole contract for such a field — do not also add `@IsOptional`,
 * `@IsArray`, `@ArrayMaxSize`, `@ValidateNested` or `@Type` alongside it.
 */
export function ValidateNestedArray(itemType: new () => object, maxSize: number): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol) {
    IsOptional()(target, propertyKey);
    IsArray()(target, propertyKey);
    ArrayMaxSize(maxSize, {
      message: bi(`${String(propertyKey)} cannot exceed ${maxSize} items`, `لا يمكن أن يتجاوز ${String(propertyKey)} ${maxSize} عناصر`),
    })(target, propertyKey);
    ValidateNested({ each: true })(target, propertyKey);
    Type(() => itemType)(target, propertyKey);
  };
}
