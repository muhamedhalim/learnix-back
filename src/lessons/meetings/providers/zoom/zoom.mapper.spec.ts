import { BadRequestException } from '@nestjs/common';

import { buildZoomMeetingBody, parseZoomMeeting, parseZoomTokenResponse, parseZoomUserInfo } from './zoom.mapper';

describe('zoom.mapper', () => {
  describe('parseZoomTokenResponse', () => {
    it('parses a full authorization_code exchange response', () => {
      const before = Date.now();
      const result = parseZoomTokenResponse({
        access_token: 'eyJhbGciOiJIUzI1NiJ9.access',
        refresh_token: 'eyJhbGciOiJIUzI1NiJ9.refresh',
        expires_in: 3599,
        scope: 'meeting:write:meeting user:read:user',
        token_type: 'bearer',
      });
      expect(result.accessToken).toBe('eyJhbGciOiJIUzI1NiJ9.access');
      expect(result.refreshToken).toBe('eyJhbGciOiJIUzI1NiJ9.refresh');
      expect(result.scopes).toEqual(['meeting:write:meeting', 'user:read:user']);
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
    });

    it('rejects a refresh-grant response missing a rotated refresh_token (Zoom always rotates it)', () => {
      expect(() =>
        parseZoomTokenResponse({
          access_token: 'new-access-token',
          expires_in: 3599,
          scope: 'meeting:write:meeting',
        }),
      ).toThrow(BadRequestException);
    });

    it('rejects a response missing access_token', () => {
      expect(() => parseZoomTokenResponse({ refresh_token: 'r', expires_in: 3599 })).toThrow(BadRequestException);
    });

    it('rejects a response with a non-positive expires_in', () => {
      expect(() => parseZoomTokenResponse({ access_token: 'x', refresh_token: 'r', expires_in: 0 })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('parseZoomUserInfo', () => {
    it('parses a full /v2/users/me response', () => {
      const result = parseZoomUserInfo({
        id: 'zAbCdEfGhI',
        email: 'teacher@example.test',
        first_name: 'Teacher',
        last_name: 'Example',
      });
      expect(result).toEqual({
        providerAccountId: 'zAbCdEfGhI',
        providerAccountEmail: 'teacher@example.test',
        displayName: 'Teacher Example',
      });
    });

    it('rejects a response missing id', () => {
      expect(() => parseZoomUserInfo({ email: 'teacher@example.test' })).toThrow(BadRequestException);
    });
  });

  describe('buildZoomMeetingBody', () => {
    it('builds a scheduled-meeting (type 2) body with duration derived from start/end', () => {
      const body = buildZoomMeetingBody({
        accessToken: 'token',
        topic: 'Algebra 101',
        startAt: new Date('2026-01-15T10:00:00.000Z'),
        endAt: new Date('2026-01-15T10:30:00.000Z'),
        timezone: 'Africa/Cairo',
        idempotencyKey: 'session-abc-123',
      });
      expect(body).toEqual({
        topic: 'Algebra 101',
        type: 2,
        start_time: '2026-01-15T10:00:00.000Z',
        duration: 30,
        timezone: 'Africa/Cairo',
        settings: { join_before_host: false, approval_type: 2 },
      });
    });
  });

  describe('parseZoomMeeting', () => {
    it('parses a fully-populated meeting-creation response (recorded fixture shape)', () => {
      const result = parseZoomMeeting({
        id: 89234782634,
        topic: 'Algebra 101',
        join_url: 'https://zoom.us/j/89234782634?pwd=abcdef',
        start_url: 'https://zoom.us/s/89234782634?zak=eyJhbGciOiJIUzI1NiJ9',
        password: '123456',
      });
      expect(result).toEqual({
        externalId: '89234782634',
        joinUrl: 'https://zoom.us/j/89234782634?pwd=abcdef',
        hostUrl: 'https://zoom.us/s/89234782634?zak=eyJhbGciOiJIUzI1NiJ9',
        passcode: '123456',
      });
    });

    it('rejects a response with no id', () => {
      expect(() => parseZoomMeeting({ join_url: 'https://zoom.us/j/1' })).toThrow(BadRequestException);
    });

    it('rejects a response with no join_url', () => {
      expect(() => parseZoomMeeting({ id: 1 })).toThrow(BadRequestException);
    });
  });
});
