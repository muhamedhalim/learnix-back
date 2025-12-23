import { ApiProperty } from '@nestjs/swagger';

export class UserInfoDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'testuser' })
  username!: string;

  @ApiProperty({ example: 'test@example.com' })
  email!: string;

  @ApiProperty({ example: 'Test User' })
  full_name!: string;

  @ApiProperty({ example: ['student'] })
  roles!: string[];

  @ApiProperty({ example: true })
  isActive!: boolean;
}

export class AuthResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token (short-lived, ~15 minutes)',
  })
  access_token!: string;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT refresh token (long-lived, ~7 days)',
  })
  refresh_token!: string;

  @ApiProperty({ type: UserInfoDto })
  user!: UserInfoDto;
}
