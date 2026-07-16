import {
  IsBoolean,
  IsIn,
  IsInt,
  IsHexColor,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
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
  @MaxLength(160)
  public title_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public body_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_title_ar?: string;

  @IsOptional()
  @IsHexColor()
  public accent_color?: string;

  @IsOptional()
  @IsIn(['classic', 'modern', 'minimal'])
  public layout?: 'classic' | 'modern' | 'minimal';

  @IsOptional()
  @IsIn(['sans', 'serif'])
  public font?: 'sans' | 'serif';

  @IsOptional()
  @IsInt()
  @Min(24)
  @Max(54)
  public title_font_size?: number;

  @IsOptional()
  @IsInt()
  @Min(12)
  @Max(24)
  public body_font_size?: number;

  @IsOptional()
  @IsIn(['left', 'center', 'right'])
  public text_alignment?: 'left' | 'center' | 'right';

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
  @MaxLength(160)
  public title_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public body?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  public body_ar?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  public signature_title_ar?: string;

  @IsOptional()
  @IsHexColor()
  public accent_color?: string;

  @IsOptional()
  @IsIn(['classic', 'modern', 'minimal'])
  public layout?: 'classic' | 'modern' | 'minimal';

  @IsOptional()
  @IsIn(['sans', 'serif'])
  public font?: 'sans' | 'serif';

  @IsOptional()
  @IsInt()
  @Min(24)
  @Max(54)
  public title_font_size?: number;

  @IsOptional()
  @IsInt()
  @Min(12)
  @Max(24)
  public body_font_size?: number;

  @IsOptional()
  @IsIn(['left', 'center', 'right'])
  public text_alignment?: 'left' | 'center' | 'right';

  @IsOptional()
  @IsBoolean()
  public is_default?: boolean;
}
