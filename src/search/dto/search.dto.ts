import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export enum SearchType {
  ALL = 'all',
  COURSES = 'courses',
  LESSONS = 'lessons',
  TEACHERS = 'teachers',
  SUBJECTS = 'subjects',
}

export class SearchQueryDto {
  @IsString()
  @MaxLength(200)
  public q!: string;

  @IsOptional()
  @IsEnum(SearchType)
  public type?: SearchType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  public limit = 20;
}

export class SuggestQueryDto {
  @IsString()
  @MaxLength(200)
  public q!: string;
}

export class InCourseSearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public q?: string;
}
