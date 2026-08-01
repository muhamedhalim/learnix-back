import { IsOptional, IsString, MaxLength } from 'class-validator';

import { Pagination20Dto } from '../../common/dto/pagination.dto';

/** Call Center can see dispatch state, never message content or recipient contact data. */
export class CallCenterNotificationFilterDto extends Pagination20Dto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  public status?: string;
}
