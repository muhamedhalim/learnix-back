import { BadRequestException } from '@nestjs/common';

import {
  buildTeamsMeetingBody,
  parseMicrosoftTokenResponse,
  parseMicrosoftUserInfo,
  parseTeamsMeeting,
} from './microsoft-teams.mapper';

describe('microsoft-teams.mapper', () => {
  describe('parseMicrosoftTokenResponse', () => {
    it('parses a full authorization_code exchange response', () => {
      const before = Date.now();
      const result = parseMicrosoftTokenResponse({
        access_token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.access',
        refresh_token: '0.AXoA.refresh',
        expires_in: 3599,
        scope: 'https://graph.microsoft.com/OnlineMeetings.ReadWrite https://graph.microsoft.com/User.Read',
        token_type: 'Bearer',
      });
      expect(result.accessToken).toBe('eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.access');
      expect(result.refreshToken).toBe('0.AXoA.refresh');
      expect(result.scopes).toEqual([
        'https://graph.microsoft.com/OnlineMeetings.ReadWrite',
        'https://graph.microsoft.com/User.Read',
      ]);
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
    });

    it('returns a null refreshToken on a refresh-token-grant response (Microsoft does not guarantee rotation)', () => {
      const result = parseMicrosoftTokenResponse({
        access_token: 'new-access-token',
        expires_in: 3599,
        scope: 'https://graph.microsoft.com/OnlineMeetings.ReadWrite',
      });
      expect(result.refreshToken).toBeNull();
    });

    it('rejects a response missing access_token', () => {
      expect(() => parseMicrosoftTokenResponse({ expires_in: 3599 })).toThrow(BadRequestException);
    });

    it('rejects a response with a non-positive expires_in', () => {
      expect(() => parseMicrosoftTokenResponse({ access_token: 'x', expires_in: 0 })).toThrow(BadRequestException);
    });
  });

  describe('parseMicrosoftUserInfo', () => {
    it('parses a full /v1.0/me response', () => {
      const result = parseMicrosoftUserInfo({
        id: '87d349ed-44d7-43e1-9a83-5f2406dee5bd',
        mail: 'teacher@contoso.test',
        userPrincipalName: 'teacher@contoso.onmicrosoft.com',
        displayName: 'Teacher Example',
      });
      expect(result).toEqual({
        providerAccountId: '87d349ed-44d7-43e1-9a83-5f2406dee5bd',
        providerAccountEmail: 'teacher@contoso.test',
        displayName: 'Teacher Example',
      });
    });

    it('falls back to userPrincipalName when mail is absent', () => {
      const result = parseMicrosoftUserInfo({
        id: '87d349ed-44d7-43e1-9a83-5f2406dee5bd',
        userPrincipalName: 'teacher@contoso.onmicrosoft.com',
        displayName: 'Teacher Example',
      });
      expect(result.providerAccountEmail).toBe('teacher@contoso.onmicrosoft.com');
    });

    it('rejects a response missing id', () => {
      expect(() => parseMicrosoftUserInfo({ mail: 'teacher@contoso.test' })).toThrow(BadRequestException);
    });
  });

  describe('buildTeamsMeetingBody', () => {
    it('builds an onlineMeetings body with UTC ISO start/end and no timezone field', () => {
      const body = buildTeamsMeetingBody({
        accessToken: 'token',
        topic: 'Algebra 101',
        startAt: new Date('2026-01-15T10:00:00.000Z'),
        endAt: new Date('2026-01-15T10:30:00.000Z'),
        timezone: 'Africa/Cairo',
        idempotencyKey: 'session-abc-123',
      });
      expect(body).toEqual({
        externalId: 'session-abc-123',
        subject: 'Algebra 101',
        startDateTime: '2026-01-15T10:00:00.000Z',
        endDateTime: '2026-01-15T10:30:00.000Z',
      });
    });
  });

  describe('parseTeamsMeeting', () => {
    it('parses a fully-populated onlineMeetings response including an audio-conferencing passcode', () => {
      const result = parseTeamsMeeting({
        id: 'MSo5MzQ0YzE5...',
        subject: 'Algebra 101',
        joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
        audioConferencing: { conferenceId: '123456789' },
      });
      expect(result).toEqual({
        externalId: 'MSo5MzQ0YzE5...',
        joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0',
        hostUrl: null,
        passcode: '123456789',
      });
    });

    it('falls back to the deprecated joinUrl field when joinWebUrl is absent', () => {
      const result = parseTeamsMeeting({ id: 'evt1', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' });
      expect(result.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/x');
      expect(result.passcode).toBeNull();
    });

    it('rejects a response with no id', () => {
      expect(() => parseTeamsMeeting({ joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/x' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a response with no usable join link', () => {
      expect(() => parseTeamsMeeting({ id: 'evt1' })).toThrow(BadRequestException);
    });
  });
});
