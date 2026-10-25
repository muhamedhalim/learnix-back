import { InternalServerErrorException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { RetryableProviderError } from '../provider-errors';
import { ZoomProvider } from './zoom.provider';

const INPUT = {
  accessToken: 'access-token',
  topic: 'Algebra 101',
  startAt: new Date('2026-01-15T10:00:00.000Z'),
  endAt: new Date('2026-01-15T10:30:00.000Z'),
  timezone: 'Africa/Cairo',
  idempotencyKey: 'session-1',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('ZoomProvider (mocked HTTP)', () => {
  let fetchMock: jest.SpyInstance;
  let provider: ZoomProvider;

  beforeEach(() => {
    const values: Record<string, string> = { ZOOM_CLIENT_ID: 'id', ZOOM_CLIENT_SECRET: 'secret' };
    provider = new ZoomProvider({ get: (key: string) => values[key] } as ConfigService);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('createMeeting returns the join URL and keeps the host start_url separate', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ id: 123456, join_url: 'https://zoom.us/j/123456', start_url: 'https://zoom.us/s/123456', password: 'pw' }, 201),
    );

    const result = await provider.createMeeting(INPUT);

    expect(result).toMatchObject({ externalId: '123456', joinUrl: 'https://zoom.us/j/123456', passcode: 'pw' });
  });

  it('createMeeting retries only on 429 (no idempotency key => a 5xx could have created a duplicate)', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': '3' }));
    const rateLimited = await provider.createMeeting(INPUT).catch((e: unknown) => e);
    expect(rateLimited).toBeInstanceOf(RetryableProviderError);
    expect((rateLimited as RetryableProviderError).retryAfterMs).toBe(3000);

    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(InternalServerErrorException);

    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('createMeeting maps 401 to reconnect-required', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));

    await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('updateMeeting PATCHes only the changing fields and treats 5xx as retryable', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await provider.updateMeeting('tok', '987', {
      topic: 'Algebra 101',
      startAt: INPUT.startAt,
      endAt: INPUT.endAt,
      timezone: 'Africa/Cairo',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.zoom.us/v2/meetings/987');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      topic: 'Algebra 101',
      start_time: '2026-01-15T10:00:00.000Z',
      duration: 30,
      timezone: 'Africa/Cairo',
    });

    fetchMock.mockResolvedValueOnce(json({}, 500));
    await expect(
      provider.updateMeeting('tok', '987', { topic: 't', startAt: INPUT.startAt, endAt: INPUT.endAt, timezone: 'UTC' }),
    ).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it('refresh: invalid_grant is reconnect-required, 5xx is retryable', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(provider.refresh('r')).rejects.toBeInstanceOf(UnauthorizedException);

    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(provider.refresh('r')).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it('deleteMeeting never throws', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));

    await expect(provider.deleteMeeting('tok', '987')).resolves.toBeUndefined();
  });
});
