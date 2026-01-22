import { IsString, IsOptional, MaxLength, Matches } from 'class-validator';

export class CallCenterUpdateStudentDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125][0-9]{8}$/, { message: 'Invalid Egyptian phone number' })
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  grade_level?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125][0-9]{8}$/, { message: 'Invalid Egyptian phone number' })
  parent_phone?: string;
}
