import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { ComplaintType } from '../enums/complaint-type.enum';

export class CreateComplaintDto {
  @IsEnum(ComplaintType)
  public type!: ComplaintType;

  @IsOptional()
  @IsUUID()
  public target_id?: string;

  @MaxLength(255)
  public subject!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(5000)
  public description!: string;
}
