import { IsString, MaxLength, MinLength } from 'class-validator';

export class TerminateUserSessionsDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  public reason!: string;
}
