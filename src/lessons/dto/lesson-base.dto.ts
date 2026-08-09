import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class LessonBaseDto {
  @ApiProperty()
  @IsString()
  @MinLength(7)
  @MaxLength(100)
  title!: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty()
  @IsUUID()
  subject_id!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  thumbnail?: string;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  is_group?: boolean;

  @ApiProperty({
    required: false,
    description: 'Playable as a free teaser on the public course preview',
  })
  @IsBoolean()
  @IsOptional()
  is_free_preview?: boolean;

  @ApiProperty({ required: false })
  @IsInt()
  @IsOptional()
  @Min(1)
  available_for_days?: number;

  @ApiProperty({ required: false, description: 'Duration in seconds' })
  @IsInt()
  @IsOptional()
  @Min(0)
  duration?: number;

}
