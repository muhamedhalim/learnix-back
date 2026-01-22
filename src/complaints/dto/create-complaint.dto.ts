import {
  IsEnum,
  IsString,
  IsNotEmpty,
  MaxLength,
  IsUUID,
  IsOptional,
} from 'class-validator';
import { ComplaintType } from '../enums/complaint-type.enum';

export class CreateComplaintDto {
  @IsEnum(ComplaintType)
  type!: ComplaintType;

  @IsOptional()
  @IsUUID()
  target_id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  description!: string;
}
