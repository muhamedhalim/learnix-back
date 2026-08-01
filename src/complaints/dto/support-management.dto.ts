import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SupportResourceFilterDto {
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsInt() @Min(1) page = 1;
  @IsOptional() @IsInt() @Min(1) @Max(100) limit = 20;
}

export class UpsertCannedResponseDto {
  @IsString() @MaxLength(160) title!: string;
  @IsString() @MaxLength(8000) body!: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

export class UpsertKnowledgeArticleDto {
  @IsString() @MaxLength(200) title!: string;
  @IsString() @MaxLength(20000) body!: string;
  @IsOptional() @IsBoolean() is_published?: boolean;
}

export class UpsertSupportSlaPolicyDto {
  @IsInt() @Min(1) @Max(720) first_response_hours!: number;
  @IsInt() @Min(1) @Max(2160) resolution_hours!: number;
  @IsInt() @Min(1) @Max(168) warning_window_hours!: number;
}
