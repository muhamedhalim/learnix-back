import {
  IsString,
  IsEmail,
  IsOptional,
  IsUrl,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(/^01[0-2,5]{1}[0-9]{8}$/, {
    message: 'Phone must be a valid Egyptian phone number',
  })
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(/^01[0-2,5]{1}[0-9]{8}$/, {
    message: 'Parent phone must be a valid Egyptian phone number',
  })
  parentPhone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  profile_picture_url?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  headline?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  password_hash?: never;
  points?: never;
  firebase_uid?: never;
  roles?: never;
  is_active?: never;
  id?: never;
  created_at?: never;
  updated_at?: never;
  deleted_at?: never;
}
