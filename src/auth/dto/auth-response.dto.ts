import { ApiProperty } from '@nestjs/swagger';

/**
 * Response when user account is pending approval
 */
export class PendingAuthResponseDto {
  @ApiProperty({
    example: 'pending',
    description: 'Account status',
    enum: ['pending'],
  })
  public status!: 'pending';

  @ApiProperty({
    example: 'Your account is under review. Please wait for admin approval.',
    description: 'Status message for the user',
  })
  public message!: string;
}

/**
 * Response when user account is approved and login succeeds
 */
export class ApprovedAuthResponseDto {
  @ApiProperty({
    example: 'approved',
    description: 'Account status',
    enum: ['approved'],
  })
  public status!: 'approved';

  @ApiProperty({
    example: 'STUDENT',
    description: 'User role',
    enum: ['ADMIN', 'CALL_CENTER', 'TEACHER', 'STUDENT'],
  })
  public role!: string;

  @ApiProperty({
    example: 'stu_123456',
    description: 'User ID (role-specific prefix: stu_, t_, admin_, cc_)',
  })
  public userId!: string;
}

/**
 * Union type for auth responses
 * Returns PendingAuthResponseDto if account is pending
 * Returns ApprovedAuthResponseDto if account is approved
 * Throws UnauthorizedException if account is rejected
 */
export type AuthResponseDto = PendingAuthResponseDto | ApprovedAuthResponseDto;
