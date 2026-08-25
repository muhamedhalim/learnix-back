import { ApiProperty } from '@nestjs/swagger';

import { MeetingProvider } from '../../entities/meeting-provider.enum';
import { TeacherMeetingAccountStatus } from '../../entities/teacher-meeting-account-status.enum';
import type { MeetingAccountSummary } from '../meeting-accounts.service';

/**
 * Public shape of a teacher's meeting connection. Deliberately excludes
 * every token field — `MeetingAccountsService` never returns the encrypted
 * columns to a DTO in the first place, so there is nothing to omit here.
 */
export class MeetingAccountSummaryDto {
  @ApiProperty({ enum: MeetingProvider })
  public provider!: MeetingProvider;

  @ApiProperty()
  public connected!: boolean;

  @ApiProperty({ enum: TeacherMeetingAccountStatus, nullable: true })
  public status!: TeacherMeetingAccountStatus | null;

  @ApiProperty({ nullable: true })
  public account_email!: string | null;

  @ApiProperty({ nullable: true })
  public display_name!: string | null;

  @ApiProperty({ nullable: true })
  public last_verified_at!: Date | null;
}

export function toMeetingAccountSummaryDto(summary: MeetingAccountSummary): MeetingAccountSummaryDto {
  return {
    provider: summary.provider,
    connected: summary.connected,
    status: summary.status,
    account_email: summary.accountEmail,
    display_name: summary.displayName,
    last_verified_at: summary.lastVerifiedAt,
  };
}
