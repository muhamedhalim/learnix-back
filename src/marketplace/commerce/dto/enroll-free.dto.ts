import { IsUUID } from 'class-validator';

export class EnrollFreeDto {
  @IsUUID()
  public courseId!: string;
}
