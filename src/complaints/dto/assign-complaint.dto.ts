import { IsInt, IsUUID, Min } from 'class-validator';

export class AssignComplaintDto {
  @IsUUID()
  public agent_id!: string;

  @IsInt()
  @Min(1)
  public version!: number;
}
