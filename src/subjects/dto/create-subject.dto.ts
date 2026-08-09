import { ApiProperty } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSubjectDto {
  @ApiProperty({
    description: 'Subject name',
    example: 'الفيزياء',
    minLength: 2,
    maxLength: 255,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  public name!: string;

  @ApiProperty({
    description: 'Subject name (Arabic)',
    example: 'الفيزياء',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  public name_ar?: string;

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

  @ApiProperty({
    description: 'Subject description (Arabic)',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public description_ar?: string;

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
