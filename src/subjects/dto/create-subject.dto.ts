import { ApiProperty } from '@nestjs/swagger';

import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export enum GradeLevel {
  GRADE_10 = 'grade_10',
  GRADE_11 = 'grade_11',
  GRADE_12 = 'grade_12',
}

export class CreateSubjectDto {
  @MaxLength(255)
  public name!: string;

  @ApiProperty({
    description: 'Subject description',
    example: 'مادة الفيزياء للصف الثالث الثانوي',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public description?: string;

  @IsNotEmpty()
  public gradeLevel!: GradeLevel;

  @ApiProperty({
    description: 'Thumbnail image URL',
    example: '/uploads/thumbnails/physics.jpg',
    required: false,
    maxLength: 500,
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  public thumbnail?: string;
}
