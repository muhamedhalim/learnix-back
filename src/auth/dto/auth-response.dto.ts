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
  status!: 'pending';

  @ApiProperty({
    example: 'Your account is under review. Please wait for admin approval.',
    description: 'Status message for the user',
  })
  message!: string;
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
  status!: 'approved';

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token (short-lived, ~15 minutes)',
  })
  token!: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT refresh token (long-lived, ~7 days)',
  })
  refreshToken!: string;

  @ApiProperty({
    example: 'STUDENT',
    description: 'User role',
    enum: ['ADMIN', 'CALL_CENTER', 'TEACHER', 'STUDENT'],
  })
  role!: string;

  @ApiProperty({
    example: 'stu_123456',
    description: 'User ID (role-specific prefix: stu_, t_, admin_, cc_)',
  })
  userId!: string;
}

/**
 * Union type for auth responses
 * Returns PendingAuthResponseDto if account is pending
 * Returns ApprovedAuthResponseDto if account is approved
 * Throws UnauthorizedException if account is rejected
 */
export type AuthResponseDto = PendingAuthResponseDto | ApprovedAuthResponseDto;
