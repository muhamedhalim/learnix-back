/**
 * `manual` preserves the pre-existing hand-typed `meeting_url` path (AD-10) —
 * it is never offered as a connectable account and never enters the OAuth flow.
 */
export enum MeetingProvider {
  GOOGLE_MEET = 'google_meet',
  ZOOM = 'zoom',
  MICROSOFT_TEAMS = 'microsoft_teams',
  MANUAL = 'manual',
}
