import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { RetryableProviderError } from '../provider-errors';
import { GoogleMeetProvider } from './google-meet.provider';

const INPUT = {
  accessToken: 'access-token',
  topic: 'Algebra 101',
  startAt: new Date('2026-01-15T10:00:00.000Z'),
  endAt: new Date('2026-01-15T10:30:00.000Z'),
  timezone: 'Africa/Cairo',
  idempotencyKey: 'abc123-1700000000000',
};
const EVENT_ID = 'abc1231700000000000';
const EVENT_URL = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${EVENT_ID}`;
const READY_EVENT = {
  id: EVENT_ID,
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  htmlLink: 'https://www.google.com/calendar/event?eid=x',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('GoogleMeetProvider (mocked HTTP)', () => {
  let fetchMock: jest.SpyInstance;
  let provider: GoogleMeetProvider;
  let sleep: jest.Mock;

  beforeEach(() => {
    const values: Record<string, string> = { GOOGLE_MEET_CLIENT_ID: 'id', GOOGLE_MEET_CLIENT_SECRET: 'secret' };
    provider = new GoogleMeetProvider({ get: (key: string) => values[key] } as ConfigService);
    sleep = jest.fn().mockResolvedValue(undefined);
    (provider as unknown as { sleep: jest.Mock }).sleep = sleep;
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  describe('createMeeting', () => {
    it('inserts an event with a deterministic id and returns the join link', async () => {
      fetchMock.mockResolvedValueOnce(json(READY_EVENT));

      const result = await provider.createMeeting(INPUT);

      expect(result).toMatchObject({ externalId: EVENT_ID, joinUrl: 'https://meet.google.com/abc-defg-hij' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/events?conferenceDataVersion=1');
      expect(JSON.parse(init.body as string)).toMatchObject({ id: EVENT_ID });
    });

    it('adopts the existing event when the insert returns 409 (a retried request)', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: { code: 409 } }, 409)).mockResolvedValueOnce(json(READY_EVENT));

      const result = await provider.createMeeting(INPUT);

      expect(result.externalId).toBe(EVENT_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe(EVENT_URL);
    });

    it('polls while the Meet conference is pending and then succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(json({ id: EVENT_ID, conferenceData: { createRequest: { status: { statusCode: 'pending' } } } }))
        .mockResolvedValueOnce(json(READY_EVENT));

      const result = await provider.createMeeting(INPUT);

      expect(result.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
      expect(sleep).toHaveBeenCalledTimes(1);
    });

    it('throws a retryable error when the conference never leaves pending (the event keeps its id for the retry)', async () => {
      const pending = { id: EVENT_ID, conferenceData: { createRequest: { status: { statusCode: 'pending' } } } };
      fetchMock.mockImplementation(() => Promise.resolve(json(pending)));

      await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(RetryableProviderError);
    });

    it('deletes the event and fails when conference creation reports failure', async () => {
      const failed = { id: EVENT_ID, conferenceData: { createRequest: { status: { statusCode: 'failure' } } } };
      fetchMock.mockResolvedValueOnce(json(failed)).mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    });

    it('maps 429 to a retryable error carrying Retry-After', async () => {
      fetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': '7' }));

      const error = await provider.createMeeting(INPUT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(RetryableProviderError);
      expect((error as RetryableProviderError).retryAfterMs).toBe(7000);
      expect((error as RetryableProviderError).statusCode).toBe(429);
    });

    it('treats Google\'s 403 rateLimitExceeded as retryable', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403));

      await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(RetryableProviderError);
    });

    it('treats a plain 403 as definitive (not retryable)', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: { errors: [{ reason: 'forbidden' }] } }, 403));

      const error = await provider.createMeeting(INPUT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(InternalServerErrorException);
    });

    it('maps a 5xx and a network failure to retryable errors', async () => {
      fetchMock.mockResolvedValueOnce(json({}, 503));
      await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(RetryableProviderError);

      fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
      await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(RetryableProviderError);
    });

    it('maps 401 to reconnect-required', async () => {
      fetchMock.mockResolvedValueOnce(json({}, 401));

      await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('updateMeeting', () => {
    it('PATCHes the event with the new times', async () => {
      fetchMock.mockResolvedValueOnce(json(READY_EVENT));

      await provider.updateMeeting('tok', 'ext-9', {
        topic: 'Algebra 101',
        startAt: INPUT.startAt,
        endAt: INPUT.endAt,
        timezone: 'Africa/Cairo',
      });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/ext-9');
      expect(init.method).toBe('PATCH');
      expect(JSON.parse(init.body as string)).toMatchObject({
        start: { dateTime: '2026-01-15T10:00:00.000Z', timeZone: 'Africa/Cairo' },
      });
    });

    it('throws (unlike delete) so the sync job can retry', async () => {
      fetchMock.mockResolvedValueOnce(json({}, 503));

      await expect(
        provider.updateMeeting('tok', 'ext-9', { topic: 't', startAt: INPUT.startAt, endAt: INPUT.endAt, timezone: 'UTC' }),
      ).rejects.toBeInstanceOf(RetryableProviderError);
    });
  });

  describe('token endpoint', () => {
    it('refresh: invalid_grant is reconnect-required, 5xx is retryable', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
      await expect(provider.refresh('r')).rejects.toBeInstanceOf(UnauthorizedException);

      fetchMock.mockResolvedValueOnce(json({}, 502));
      await expect(provider.refresh('r')).rejects.toBeInstanceOf(RetryableProviderError);
    });
  });

  describe('deleteMeeting', () => {
    it('never throws, even when the provider fails', async () => {
      fetchMock.mockResolvedValueOnce(json({}, 500));

      await expect(provider.deleteMeeting('tok', 'ext-1')).resolves.toBeUndefined();
    });
  });
});
