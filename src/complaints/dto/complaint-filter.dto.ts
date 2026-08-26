import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';
import { ComplaintStatus } from '../enums/complaint-status.enum';
import { ComplaintType } from '../enums/complaint-type.enum';
import { StrictBooleanQuery } from '../../common/decorators/strict-boolean-query.decorator';

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

  /** DEF-012: filters to tickets with no assigned agent (dashboard deep-link). */
  @StrictBooleanQuery()
  public unassigned?: boolean;

  /**
   * DEF-012: filters to the same "delayed" ticket set the dashboard's
   * Overdue card counts (mirrors `supportReport().delayed`), so the number
   * on the card and the size of the list it links to always agree.
   */
  @StrictBooleanQuery()
  public overdue?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;
}
