import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsNotEmpty, IsString, MaxLength, Min, ValidateIf } from 'class-validator';

import { ComplaintStatus } from '../enums/complaint-status.enum';

export class TransitionComplaintDto {
  @IsEnum(ComplaintStatus)
  public status!: ComplaintStatus;

  @IsInt()
  @Min(1)
  public version!: number;

  @ValidateIf((dto: TransitionComplaintDto) =>
    [ComplaintStatus.CLOSED, ComplaintStatus.REOPENED, ComplaintStatus.ESCALATED].includes(dto.status),
  )
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  public reason?: string;

  @ValidateIf((dto: TransitionComplaintDto) => dto.status === ComplaintStatus.RESOLVED || dto.resolution !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  public resolution?: string;
}
