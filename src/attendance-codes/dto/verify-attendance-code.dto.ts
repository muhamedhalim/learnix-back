import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, Length } from 'class-validator';

export class VerifyAttendanceCodeDto {
  @ApiProperty({
    description: 'The purchase code to redeem',
    example: 'A3X9K2M7',
    minLength: 8,
    maxLength: 16,
  })
  @IsString()
  @IsNotEmpty()
  @Length(8, 16)
  code!: string;
}
