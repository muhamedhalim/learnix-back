import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { StrictIntegerQuery } from '../../common/decorators/strict-integer-query.decorator';

export enum SearchType {
  ALL = 'all',
  COURSES = 'courses',
  LESSONS = 'lessons',
  BOOKS = 'books',
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
  @StrictIntegerQuery({ max: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(1)
  public page = 1;

  @IsOptional()
  @StrictIntegerQuery({ max: 50 })
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

export class PopularSearchQueryDto {
  @IsOptional()
  @StrictIntegerQuery({ max: 50 })
  public limit = 8;
}

export class InCourseSearchDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  public q?: string;
}
