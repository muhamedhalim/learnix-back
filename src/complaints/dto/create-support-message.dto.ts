import { IsBoolean, IsOptional } from 'class-validator';

import { CreateComplaintMessageDto } from './create-complaint-message.dto';

export class CreateSupportMessageDto extends CreateComplaintMessageDto {
  @IsOptional()
  @IsBoolean()
  public internal = false;
}
