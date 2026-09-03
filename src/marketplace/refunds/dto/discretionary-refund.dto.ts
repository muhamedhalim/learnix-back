import { IsString, IsUUID, MinLength } from 'class-validator';

export class DiscretionaryRefundDto {
  @IsUUID()
  public refundRequestId!: string;

  @IsString()
  @MinLength(1)
  public reason!: string;
}
