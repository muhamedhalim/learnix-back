import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { Pagination20Dto } from '../../common/dto/pagination.dto';
import { UserRole } from '../../users/entities/user-role.enum';

export class CallCenterUserFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;

  @IsOptional()
  @IsEnum([UserRole.STUDENT, UserRole.TEACHER])
  public role?: UserRole.STUDENT | UserRole.TEACHER;
}
