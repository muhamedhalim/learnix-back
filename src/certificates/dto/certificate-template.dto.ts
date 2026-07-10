import {
  IsBoolean,
  IsHexColor,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  public name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_title?: string;

  @IsOptional()
  @IsHexColor()
  public accent_color?: string;

  @IsOptional()
  @IsBoolean()
  public is_default?: boolean;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  public name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  public title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_title?: string;

  @IsOptional()
  @IsHexColor()
  public accent_color?: string;

  @IsOptional()
  @IsBoolean()
  public is_default?: boolean;
}
