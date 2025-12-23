import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, IsOptional } from 'class-validator';

export class UpdateSubjectDto {
  @ApiProperty({
    description: 'Subject name in English',
    example: 'Advanced Physics',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(255)
  title?: string;

  @ApiProperty({
    description: 'Subject name in Arabic',
    example: 'الفيزياء المتقدمة',
    required: false,
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(255)
  title_ar?: string;

  @ApiProperty({
    description: 'Subject description in English',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: 'Subject description in Arabic',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  description_ar?: string;
}
