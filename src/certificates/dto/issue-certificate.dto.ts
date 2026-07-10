import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** Admin manual certificate issuance (override). */
export class IssueCertificateDto {
  @IsUUID()
  public studentId!: string;

  @IsUUID()
  public packageId!: string;

  @IsOptional()
  @IsBoolean()
  public force?: boolean;
}
