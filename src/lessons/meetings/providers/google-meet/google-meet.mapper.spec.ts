import { BadRequestException } from '@nestjs/common';

import {
  buildCalendarEventBody,
  parseGoogleCalendarEvent,
  parseGoogleTokenResponse,
  parseGoogleUserInfo,
} from './google-meet.mapper';

describe('google-meet.mapper', () => {
  describe('parseGoogleTokenResponse', () => {
    it('parses a full authorization_code exchange response', () => {
      const before = Date.now();
      const result = parseGoogleTokenResponse({
        access_token: 'ya29.access-token',
        refresh_token: '1//refresh-token',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/calendar.events openid',
        token_type: 'Bearer',
      });
      expect(result.accessToken).toBe('ya29.access-token');
      expect(result.refreshToken).toBe('1//refresh-token');
      expect(result.scopes).toEqual(['https://www.googleapis.com/auth/calendar.events', 'openid']);
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3599 * 1000);
    });

    it('returns a null refreshToken on a refresh-token-grant response (Google does not rotate it)', () => {
      const result = parseGoogleTokenResponse({
        access_token: 'ya29.new-access-token',
        expires_in: 3599,
        scope: 'https://www.googleapis.com/auth/calendar.events',
      });
      expect(result.refreshToken).toBeNull();
    });

    it('rejects a response missing access_token', () => {
      expect(() => parseGoogleTokenResponse({ expires_in: 3599 })).toThrow(BadRequestException);
    });

    it('rejects a response with a non-positive expires_in', () => {
      expect(() => parseGoogleTokenResponse({ access_token: 'x', expires_in: 0 })).toThrow(BadRequestException);
    });
  });

  describe('parseGoogleUserInfo', () => {
    it('parses a full userinfo response', () => {
      const result = parseGoogleUserInfo({
        sub: '109876543210',
        email: 'teacher@example.test',
        email_verified: true,
        name: 'Teacher Example',
      });
      expect(result).toEqual({
        providerAccountId: '109876543210',
        providerAccountEmail: 'teacher@example.test',
        displayName: 'Teacher Example',
      });
    });

    it('rejects a response missing sub', () => {
      expect(() => parseGoogleUserInfo({ email: 'teacher@example.test' })).toThrow(BadRequestException);
    });
  });

  describe('buildCalendarEventBody', () => {
    it('builds a conferenceData.createRequest event body keyed by the idempotency key', () => {
      const body = buildCalendarEventBody({
        accessToken: 'token',
        topic: 'Algebra 101',
        startAt: new Date('2026-01-15T10:00:00.000Z'),
        endAt: new Date('2026-01-15T10:30:00.000Z'),
        timezone: 'Africa/Cairo',
        idempotencyKey: 'session-abc-123',
      });
      expect(body).toEqual({
        id: 'sessionabc123',
        summary: 'Algebra 101',
        start: { dateTime: '2026-01-15T10:00:00.000Z', timeZone: 'Africa/Cairo' },
        end: { dateTime: '2026-01-15T10:30:00.000Z', timeZone: 'Africa/Cairo' },
        conferenceData: {
          createRequest: {
            requestId: 'session-abc-123',
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      });
    });
  });

  describe('parseGoogleCalendarEvent', () => {
    it('parses a fully-populated events.insert response (recorded fixture shape)', () => {
      const result = parseGoogleCalendarEvent({
        id: 'abc123def456',
        status: 'confirmed',
        htmlLink: 'https://www.google.com/calendar/event?eid=abc123def456',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        conferenceData: {
          conferenceId: 'abc-defg-hij',
          entryPoints: [
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
            { entryPointType: 'phone', uri: 'tel:+1-234-567-8901', pin: '123456789' },
            { entryPointType: 'more', uri: 'https://tel.meet/abc-defg-hij?pin=123456789' },
          ],
          conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
        },
      });
      expect(result).toEqual({
        externalId: 'abc123def456',
        joinUrl: 'https://meet.google.com/abc-defg-hij',
        hostUrl: 'https://www.google.com/calendar/event?eid=abc123def456',
        passcode: '123456789',
      });
    });

    it('falls back to the video entry point uri when hangoutLink is absent', () => {
      const result = parseGoogleCalendarEvent({
        id: 'evt1',
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xyz-uvwx-yz' }],
        },
      });
      expect(result.joinUrl).toBe('https://meet.google.com/xyz-uvwx-yz');
      expect(result.passcode).toBeNull();
    });

    it('rejects a response with no id', () => {
      expect(() => parseGoogleCalendarEvent({ hangoutLink: 'https://meet.google.com/x' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects a response with no usable join link', () => {
      expect(() => parseGoogleCalendarEvent({ id: 'evt1' })).toThrow(BadRequestException);
    });
  });
});
