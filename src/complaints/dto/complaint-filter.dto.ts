import { ComplaintStatus } from '../enums/complaint-status.enum';
import { ComplaintType } from '../enums/complaint-type.enum';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Min } from 'class-validator';

export class ComplaintFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public limit = 20;

  @IsOptional()
  @IsEnum(ComplaintStatus)
  public status?: ComplaintStatus;

  @IsOptional()
  @IsEnum(ComplaintType)
  public type?: ComplaintType;
}
