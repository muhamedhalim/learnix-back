import { IsEnum, IsOptional, IsUUID, MaxLength } from 'class-validator';

import { ComplaintType } from '../enums/complaint-type.enum';

export class CreateComplaintDto {
  @IsEnum(ComplaintType)
  public type!: ComplaintType;

  @IsOptional()
  @IsUUID()
  public target_id?: string;

  @MaxLength(255)
  public subject!: string;

  @MaxLength(5000)
  public description!: string;
}
