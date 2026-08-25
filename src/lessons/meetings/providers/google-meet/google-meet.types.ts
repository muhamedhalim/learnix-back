export interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface GoogleUserInfoResponse {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

export interface GoogleCalendarEventResponse {
  id?: unknown;
  hangoutLink?: unknown;
  htmlLink?: unknown;
  conferenceData?: unknown;
}
