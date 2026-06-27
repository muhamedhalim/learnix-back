import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, Min } from 'class-validator';

export class UpdateProgressDto {
  @ApiProperty({
    description: 'Total watched duration in seconds',
    example: 3600,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  public watchedDuration!: number;

  @ApiPropertyOptional({
    description:
      'Total duration of the lesson in seconds (optional, uses lesson.duration if not provided)',
    example: 7200,
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  public totalDuration?: number;
}

export class LessonProgressDto {
  @ApiProperty({ description: 'Progress record ID' })
  public id!: string;

  @ApiProperty({ description: 'Lesson ID' })
  public lessonId!: string;

  @ApiProperty({ description: 'Lesson title' })
  public lessonTitle!: string;

  @ApiProperty({ description: 'Total watched duration in seconds' })
  public watchedDuration!: number;

  @ApiProperty({ description: 'Total lesson duration in seconds' })
  public totalDuration!: number;

  @ApiProperty({ description: 'Progress percentage (0-100)' })
  public progressPercent!: number;

  @ApiProperty({ description: 'Whether the lesson is completed' })
  public completed!: boolean;

  @ApiProperty({ description: 'Last watched timestamp' })
  public lastWatchedAt!: Date;
}

export class LessonProgressResponseDto {
  @ApiProperty({ description: 'Success message' })
  public message!: string;

  @ApiProperty({ type: LessonProgressDto, description: 'Progress data' })
  public data!: LessonProgressDto;
}

export class LessonProgressNullableResponseDto {
  @ApiProperty({
    type: LessonProgressDto,
    nullable: true,
    description: 'Progress data or null if no progress exists',
  })
  public data!: LessonProgressDto | null;
}

export class AllProgressResponseDto {
  @ApiProperty({
    type: [LessonProgressDto],
    description: 'Array of progress records',
  })
  public data!: LessonProgressDto[];
}
