import { Length } from 'class-validator';

export class VerifyAttendanceCodeDto {
  @Length(8, 16)
  public code!: string;
}
