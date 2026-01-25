import { IsOptional, IsString, Matches,MaxLength } from 'class-validator';

export class CallCenterUpdateStudentDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  public name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125][0-9]{8}$/, { message: 'Invalid Egyptian phone number' })
  public phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  public grade_level?: string;

  @IsOptional()
  @IsString()
  @Matches(/^01[0125][0-9]{8}$/, { message: 'Invalid Egyptian phone number' })
  public parent_phone?: string;
}
