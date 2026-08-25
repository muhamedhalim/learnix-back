import { ApiProperty } from '@nestjs/swagger';

import { MeetingProvider } from '../../entities/meeting-provider.enum';

export class MeetingProviderStatusDto {
  @ApiProperty({ enum: MeetingProvider })
  public provider!: MeetingProvider;

  @ApiProperty({ description: 'Whether the platform has this provider configured (env vars present).' })
  public configured!: boolean;
}
