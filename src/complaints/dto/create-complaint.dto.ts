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
  /** Client-generated idempotency key. Reusing it returns the first ticket. */
  @IsOptional()
  @IsUUID()
  public request_id?: string;

  @IsEnum(ComplaintType)
  public type!: ComplaintType;

  @IsOptional()
  @IsUUID()
  public target_id?: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
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
