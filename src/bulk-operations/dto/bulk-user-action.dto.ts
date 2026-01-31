import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsUUID } from 'class-validator';

/**
 * Available bulk actions for users
 */
export enum BulkUserAction {
  SUSPEND = 'suspend',
  ACTIVATE = 'activate',
  DELETE = 'delete',
}

/**
 * DTO for bulk user action request
 */
export class BulkUserActionDto {
  @ApiProperty({
    description: 'Action to perform',
    enum: BulkUserAction,
    example: BulkUserAction.SUSPEND,
  })
  @IsEnum(BulkUserAction)
  public action!: BulkUserAction;

  @ApiProperty({
    description: 'Array of user IDs to perform action on',
    type: [String],
    example: ['uuid-1', 'uuid-2', 'uuid-3'],
  })
  @IsArray()
  @IsUUID('4', { each: true })
  public user_ids!: string[];
}

/**
 * Response DTO for bulk user action operation
 */
export class BulkUserActionResultDto {
  @ApiProperty({ description: 'Action performed' })
  public action!: BulkUserAction;

  @ApiProperty({ description: 'Total users targeted' })
  public total_targeted!: number;

  @ApiProperty({ description: 'Successfully processed count' })
  public success_count!: number;

  @ApiProperty({ description: 'Failed count' })
  public failed_count!: number;

  @ApiProperty({ description: 'Skipped (already in state) count' })
  public skipped_count!: number;

  @ApiProperty({
    description: 'Error details per user',
    type: [Object],
    example: [{ user_id: 'uuid', error: 'User not found' }],
  })
  public errors!: Array<{
    user_id: string;
    error: string;
  }>;

  @ApiProperty({
    description: 'Processing completed at',
  })
  public completed_at!: Date;
}
