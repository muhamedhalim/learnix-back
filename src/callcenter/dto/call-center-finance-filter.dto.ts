import { IsOptional, IsString, MaxLength } from 'class-validator';

import { Pagination20Dto } from '../../common/dto/pagination.dto';

export class CallCenterFinanceFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  public status?: string;
}
