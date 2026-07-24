import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Deliberate acknowledgement required for irreversible account erasure. */
export class HardDeleteAccountDto {
  @IsString()
  @IsIn(['DELETE'])
  confirmation!: 'DELETE';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
