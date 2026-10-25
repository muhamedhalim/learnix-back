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
  if (typeof value !== 'string' || value.trim() === '') throw malformed(field);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function malformed(field: string): BadRequestException {
  return new BadRequestException(`Malformed Google Meet response field: ${field}`);
}

/** Parses Google's OAuth token endpoint response (used by both exchange and refresh). */
export function parseGoogleTokenResponse(data: unknown): MeetingTokenSet {
  const body = record(data, 'token response');
  const accessToken = stringValue(body['access_token'], 'access_token');
  const refreshToken = optionalString(body['refresh_token']);
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

/** Parses the OIDC userinfo response used to identify which Google account was connected. */
export function parseGoogleUserInfo(data: unknown): MeetingAccountIdentity {
  const body = record(data, 'userinfo response');
  return {
    providerAccountId: stringValue(body['sub'], 'sub'),
    providerAccountEmail: optionalString(body['email']),
    displayName: optionalString(body['name']),
  };
}

/**
 * Google event ids must be 5-1024 chars of base32hex (`a-v`, `0-9`). The
 * idempotency key (a session UUID plus a request timestamp) is reduced to that
 * alphabet, which keeps it deterministic for one Generate request.
 */
export function googleEventIdFromKey(idempotencyKey: string): string {
  const id = idempotencyKey.toLowerCase().replace(/[^a-v0-9]/g, '');
  if (id.length < 5) throw malformed('idempotency key');
  return id;
}

/**
 * `conferenceDataVersion=1` requests a Google Meet link be created alongside
 * the calendar event via `conferenceData.createRequest`. `requestId` only
 * dedupes the CONFERENCE, not the event, so the event itself also gets a
 * deterministic `id`: a retried insert then fails with 409 (the provider
 * adapter fetches the existing event) instead of creating a second event.
 */
export function buildCalendarEventBody(input: CreateMeetingInput): Record<string, unknown> {
  return {
    id: googleEventIdFromKey(input.idempotencyKey),
    summary: input.topic,
    start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
    conferenceData: {
      createRequest: {
        requestId: input.idempotencyKey,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    },
  };
}

export function buildCalendarEventUpdateBody(input: UpdateMeetingInput): Record<string, unknown> {
  return {
    summary: input.topic,
    start: { dateTime: input.startAt.toISOString(), timeZone: input.timezone },
    end: { dateTime: input.endAt.toISOString(), timeZone: input.timezone },
  };
}

/** `pending` = Google is still creating the Meet conference; `failure` = it gave up. */
export function googleConferenceState(data: unknown): 'ready' | 'pending' | 'failed' {
  const event = record(data, 'event');
  if (optionalString(event['hangoutLink'])) return 'ready';
  const conferenceData = isRecord(event['conferenceData']) ? event['conferenceData'] : undefined;
  if (!conferenceData) return 'pending';
  const entryPoints = Array.isArray(conferenceData['entryPoints']) ? conferenceData['entryPoints'] : [];
  if (entryPoints.some((entry) => isRecord(entry) && entry['entryPointType'] === 'video')) return 'ready';
  const createRequest = isRecord(conferenceData['createRequest']) ? conferenceData['createRequest'] : undefined;
  const status = createRequest && isRecord(createRequest['status']) ? createRequest['status'] : undefined;
  return status?.['statusCode'] === 'failure' ? 'failed' : 'pending';
}

export function parseGoogleCalendarEvent(data: unknown): CreateMeetingResult {
  const event = record(data, 'event');
  const externalId = stringValue(event['id'], 'id');
  const conferenceData = isRecord(event['conferenceData']) ? event['conferenceData'] : undefined;
  const entryPoints = conferenceData && Array.isArray(conferenceData['entryPoints']) ? conferenceData['entryPoints'] : [];
  const videoEntry = entryPoints.find((entry) => isRecord(entry) && entry['entryPointType'] === 'video');
  const joinUrl = optionalString(event['hangoutLink']) ?? (isRecord(videoEntry) ? optionalString(videoEntry['uri']) : null);
  if (!joinUrl) throw malformed('hangoutLink');
  const phoneEntry = entryPoints.find((entry) => isRecord(entry) && entry['entryPointType'] === 'phone');
  const passcode = isRecord(phoneEntry) ? optionalString(phoneEntry['pin']) : null;
  return {
    externalId,
    joinUrl,
    hostUrl: optionalString(event['htmlLink']),
    passcode,
  };
}
