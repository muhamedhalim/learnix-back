import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

const INVALID_EGYPTIAN_PHONE = bi('Invalid Egyptian phone number', 'رقم هاتف مصري غير صالح');

export class CallCenterUpdateStudentDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125]\d{8}$/, { message: INVALID_EGYPTIAN_PHONE })
  public phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  public grade_level?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125]\d{8}$/, { message: INVALID_EGYPTIAN_PHONE })
  public parent_phone?: string;
}
