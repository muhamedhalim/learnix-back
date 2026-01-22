import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class RespondComplaintDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  admin_response!: string;
}
