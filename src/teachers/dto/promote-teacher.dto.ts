import { ApiProperty } from '@nestjs/swagger';

import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Promote an existing STUDENT account into a TEACHER.
 * The optional profile fields seed the new teacher profile; sensible defaults
 * are applied when they are omitted so the admin can promote in one click.
 */
export class PromoteTeacherDto {
  @ApiProperty({
    description: 'User ID of the student to promote',
    example: 'aee11005-f2b2-485c-994c-fbf3682cce39',
  })
  @IsUUID()
  public user_id!: string;

  @ApiProperty({
    description: 'Teacher qualifications',
    example: 'B.Sc. Mathematics, 5 years tutoring',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public qualifications?: string;

  @ApiProperty({
    description: 'Years of teaching experience',
    example: 5,
    required: false,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  public years_of_experience?: number;

  @ApiProperty({
    description: 'Short bio',
    example: 'Passionate mathematics teacher.',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public bio?: string;
}
