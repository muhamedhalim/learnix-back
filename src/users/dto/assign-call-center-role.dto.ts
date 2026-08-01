import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * This endpoint has no caller-controlled `role` field. An optional reason is
 * retained in the audit record, while the server always assigns CALL_CENTER.
 */
export class AssignCallCenterRoleDto {
  @ApiPropertyOptional({ maxLength: 250 })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  public reason?: string;
}
