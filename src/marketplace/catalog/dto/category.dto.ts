import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @MaxLength(150)
  name_en!: string;

  @IsString()
  @MaxLength(150)
  name_ar!: string;

  @IsOptional()
  @IsString()
  description_en?: string;

  @IsOptional()
  @IsString()
  description_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  icon_key?: string;

  @IsOptional()
  @IsUUID('4')
  parent_id?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name_en?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  name_ar?: string;

  @IsOptional()
  @IsString()
  description_en?: string;

  @IsOptional()
  @IsString()
  description_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  icon_key?: string;

  @IsOptional()
  @IsUUID('4')
  parent_id?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  display_order?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
