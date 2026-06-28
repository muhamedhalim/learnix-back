import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'One-time password reset token delivered by email',
  })
  @IsString()
  @IsNotEmpty({ message: 'Reset token is required' })
  public token!: string;

  @ApiProperty({
    example: 'newSecret123',
    description: 'New password (min 8 chars)',
  })
  @IsString()
  @IsNotEmpty({ message: 'New password is required' })
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128, { message: 'Password must be at most 128 characters' })
  public newPassword!: string;
}
