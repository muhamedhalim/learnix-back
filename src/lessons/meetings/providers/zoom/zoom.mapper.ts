import { BadRequestException } from '@nestjs/common';

import type {
  CreateMeetingInput,
  CreateMeetingResult,
  MeetingAccountIdentity,
  MeetingTokenSet,
  UpdateMeetingInput,
} from '../meeting-provider.interface';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw malformed(field);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.trim() === '') throw malformed(field);
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function malformed(field: string): BadRequestException {
  return new BadRequestException(`Malformed Zoom response field: ${field}`);
}

/**
 * Parses Zoom's OAuth token endpoint response (used by both exchange and
 * refresh). Unlike Google, Zoom **always** rotates the refresh token — a
 * response missing one indicates a malformed reply, not "unchanged" (see
 * `ZoomProvider` doc comment / plan Phase 6 gotcha).
 */
export function parseZoomTokenResponse(data: unknown): MeetingTokenSet {
  const body = record(data, 'token response');
  const accessToken = stringValue(body['access_token'], 'access_token');
  const refreshToken = optionalString(body['refresh_token']);
  if (!refreshToken) throw malformed('refresh_token');
  const expiresInRaw = body['expires_in'];
  const expiresIn = typeof expiresInRaw === 'number' ? expiresInRaw : Number(expiresInRaw);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw malformed('expires_in');
  const scopeValue = optionalString(body['scope']);
  const scopes = scopeValue ? scopeValue.split(' ').filter((s) => s !== '') : [];
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scopes,
  };
}

/** Parses the `GET /v2/users/me` response used to identify which Zoom account was connected. */
export function parseZoomUserInfo(data: unknown): MeetingAccountIdentity {
  const body = record(data, 'user response');
  const firstName = optionalString(body['first_name']);
  const lastName = optionalString(body['last_name']);
  const displayName = [firstName, lastName].filter((part): part is string => part !== null).join(' ') || null;
  return {
    providerAccountId: stringValue(body['id'], 'id'),
    providerAccountEmail: optionalString(body['email']),
    displayName,
  };
}

/**
 * Zoom's meeting-creation body. `type: 2` is a scheduled meeting. Zoom has no
 * documented native idempotency key for this endpoint (unlike Google's
 * `conferenceData.createRequest.requestId`) — `input.idempotencyKey` is
 * therefore not sent here; de-duplication relies entirely on AD-8 layers 2
 * (BullMQ jobId + conditional claim) and 3 (the DB unique index), which is
 * the accepted residual risk documented as R-15.
 */
export function buildZoomMeetingBody(input: CreateMeetingInput): Record<string, unknown> {
  const durationMinutes = Math.max(1, Math.round((input.endAt.getTime() - input.startAt.getTime()) / 60_000));
  return {
    topic: input.topic,
    type: 2,
    start_time: input.startAt.toISOString(),
    duration: durationMinutes,
    timezone: input.timezone,
    settings: {
      join_before_host: false,
      approval_type: 2,
    },
  };
}

/** PATCH body for a reschedule — only the fields that change, leaving `settings` untouched. */
export function buildZoomUpdateBody(input: UpdateMeetingInput): Record<string, unknown> {
  const durationMinutes = Math.max(1, Math.round((input.endAt.getTime() - input.startAt.getTime()) / 60_000));
  return {
    topic: input.topic,
    start_time: input.startAt.toISOString(),
    duration: durationMinutes,
    timezone: input.timezone,
  };
}

/**
 * `start_url` embeds a host token (ZAK) that lets the bearer start the meeting
 * as the teacher, so it is deliberately NOT persisted: `hostUrl` stays null and
 * the teacher starts the meeting by signing in to Zoom with the join link.
 */
export function parseZoomMeeting(data: unknown): CreateMeetingResult {
  const body = record(data, 'meeting');
  return {
    externalId: stringValue(body['id'], 'id'),
    joinUrl: stringValue(body['join_url'], 'join_url'),
    hostUrl: null,
    passcode: optionalString(body['password']),
  };
}
