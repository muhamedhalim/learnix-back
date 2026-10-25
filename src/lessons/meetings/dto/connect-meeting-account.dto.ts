import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsIn, IsOptional } from 'class-validator';

/** Locales the web app serves; the OAuth callback uses it to land the teacher back in the right one. */
export const MEETING_CONNECT_LOCALES = ['en', 'ar'] as const;
export type MeetingConnectLocale = (typeof MEETING_CONNECT_LOCALES)[number];

export class ConnectMeetingAccountDto {
  @ApiPropertyOptional({ enum: MEETING_CONNECT_LOCALES })
  @IsOptional()
  @IsIn(MEETING_CONNECT_LOCALES)
  public locale?: MeetingConnectLocale;
}
