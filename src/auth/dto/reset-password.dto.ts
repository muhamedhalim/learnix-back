import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'One-time password reset token delivered by email',
  })
  @IsString()
  @IsNotEmpty({ message: bi('Reset token is required', 'رمز إعادة التعيين مطلوب') })
  public token!: string;

  @ApiProperty({
    example: 'newSecret123',
    description: 'New password (min 8 chars)',
  })
  @IsString()
  @IsNotEmpty({ message: bi('New password is required', 'كلمة المرور الجديدة مطلوبة') })
  @MinLength(8, {
    message: bi('Password must be at least 8 characters', 'يجب ألا تقل كلمة المرور عن 8 أحرف'),
  })
  @MaxLength(128, {
    message: bi('Password must be at most 128 characters', 'يجب ألا تزيد كلمة المرور عن 128 حرفًا'),
  })
  public newPassword!: string;
}
