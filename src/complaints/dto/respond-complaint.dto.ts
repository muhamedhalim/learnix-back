import { MaxLength } from 'class-validator';

export class RespondComplaintDto {
  @MaxLength(5000)
  public admin_response!: string;
}
