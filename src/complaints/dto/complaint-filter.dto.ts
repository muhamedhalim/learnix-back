import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { ComplaintStatus } from '../enums/complaint-status.enum';
import { ComplaintType } from '../enums/complaint-type.enum';

export class ComplaintFilterDto {
  @IsOptional()
  @StrictIntegerQuery()
  @IsInt()
  @Min(1)
  public page = 1;

  @IsOptional()
  @StrictIntegerQuery({ max: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  public limit = 20;

  @IsOptional()
  @IsEnum(ComplaintStatus)
  public status?: ComplaintStatus;

  @IsOptional()
  @IsEnum(ComplaintType)
  public type?: ComplaintType;

  @IsOptional()
  @IsUUID()
  public assigned_agent_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;
}
