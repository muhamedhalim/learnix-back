export interface MicrosoftTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface MicrosoftUserInfoResponse {
  id?: unknown;
  mail?: unknown;
  userPrincipalName?: unknown;
  displayName?: unknown;
}

export interface MicrosoftOnlineMeetingResponse {
  id?: unknown;
  joinWebUrl?: unknown;
  joinUrl?: unknown;
  audioConferencing?: { conferenceId?: unknown } | null;
}
