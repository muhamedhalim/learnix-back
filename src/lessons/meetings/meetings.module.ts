import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TeacherMeetingAccount } from '../entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountsController } from './controllers/teacher-meeting-accounts.controller';
import { TeacherMeetingProvidersController } from './controllers/teacher-meeting-providers.controller';
import { MeetingAccountsService } from './meeting-accounts.service';
import { MeetingProviderRegistry } from './meeting-provider-registry.service';
import { MEETING_PROVIDERS } from './providers/meeting-provider.interface';
import { GoogleMeetProvider } from './providers/google-meet/google-meet.provider';
import { ZoomProvider } from './providers/zoom/zoom.provider';
import { MicrosoftTeamsProvider } from './providers/microsoft-teams/microsoft-teams.provider';

/**
 * Provider-agnostic meeting account infrastructure (Phase 3), now with its
 * first concrete provider (Phase 4). Standalone — it has no dependency on
 * `LessonsModule` or `PaymentsModule` and none of them depend on it yet, so
 * there is no circularity to manage (unlike `LessonSessionsService`, which
 * lives in `PaymentsModule` — see AD-3/R-4). That dependency is only
 * introduced in Phase 5, when meeting generation needs to read/write
 * `ScheduledLessonSession` rows.
 *
 * Zoom (Phase 6) and Microsoft Teams (Phase 7) complete the provider
 * roster — every provider named in AD-6 now has a concrete implementation.
 * `MeetingProviderRegistry` required no changes across any of these
 * phases — it reports `configured: false` for any provider whose env vars
 * are unset, exactly the same as it does for one that hasn't shipped yet.
 */
@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([TeacherMeetingAccount])],
  controllers: [TeacherMeetingProvidersController, TeacherMeetingAccountsController],
  providers: [
    MeetingProviderRegistry,
    MeetingAccountsService,
    GoogleMeetProvider,
    ZoomProvider,
    MicrosoftTeamsProvider,
    {
      provide: MEETING_PROVIDERS,
      useFactory: (googleMeet: GoogleMeetProvider, zoom: ZoomProvider, msTeams: MicrosoftTeamsProvider) => [
        googleMeet,
        zoom,
        msTeams,
      ],
      inject: [GoogleMeetProvider, ZoomProvider, MicrosoftTeamsProvider],
    },
  ],
  exports: [MeetingProviderRegistry, MeetingAccountsService],
})
export class MeetingsModule {}
