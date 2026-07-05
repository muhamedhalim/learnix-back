import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Bulk actions an admin can apply to a selection of codes.
 * (Export/Print are handled by dedicated export endpoints, not this DTO.)
 */
export enum BulkCodeAction {
  REVOKE = 'revoke',
  ENABLE = 'enable',
  DISABLE = 'disable',
  DELETE = 'delete',
}

export class BulkCodeActionDto {
  @ApiProperty({ enum: BulkCodeAction, description: 'Action to apply' })
  @IsEnum(BulkCodeAction)
  public action!: BulkCodeAction;

  @ApiProperty({
    description: 'Code IDs to act on (max 10,000 per request)',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10_000)
  @IsUUID('4', { each: true })
  public code_ids!: string[];

  @ApiPropertyOptional({ description: 'Reason (recorded in the audit trail)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  public reason?: string;
}
