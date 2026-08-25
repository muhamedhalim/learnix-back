export interface ZoomTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  reason?: unknown;
}

export interface ZoomUserInfoResponse {
  id?: unknown;
  email?: unknown;
  first_name?: unknown;
  last_name?: unknown;
}

export interface ZoomMeetingResponse {
  id?: unknown;
  join_url?: unknown;
  start_url?: unknown;
  password?: unknown;
}
