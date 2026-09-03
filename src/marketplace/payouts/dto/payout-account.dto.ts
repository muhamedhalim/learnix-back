import { IsNotEmpty, IsOptional, IsString, Length, MaxLength } from 'class-validator';

/** FR-200 — the raw identifier is only ever accepted here and in `UpdatePayoutAccountDto`; it is encrypted before it reaches storage. */
export class CreatePayoutAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  account_holder_name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  bank_name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  account_identifier!: string;

  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsString()
  @Length(2, 2)
  country!: string;
}

export class UpdatePayoutAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  account_holder_name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  bank_name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  account_identifier?: string;
}
