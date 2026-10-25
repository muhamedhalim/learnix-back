import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { RetryableProviderError } from '../provider-errors';
import { MicrosoftTeamsProvider } from './microsoft-teams.provider';

const INPUT = {
  accessToken: 'access-token',
  topic: 'Algebra 101',
  startAt: new Date('2026-01-15T10:00:00.000Z'),
  endAt: new Date('2026-01-15T10:30:00.000Z'),
  timezone: 'Africa/Cairo',
  idempotencyKey: 'session-1-1700000000000',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('MicrosoftTeamsProvider (mocked HTTP)', () => {
  let fetchMock: jest.SpyInstance;
  let provider: MicrosoftTeamsProvider;

  beforeEach(() => {
    const values: Record<string, string> = {
      MS_TEAMS_CLIENT_ID: 'id',
      MS_TEAMS_CLIENT_SECRET: 'secret',
      MS_TEAMS_TENANT: 'organizations',
    };
    provider = new MicrosoftTeamsProvider({ get: (key: string) => values[key] } as ConfigService);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('createMeeting uses the idempotent createOrGet endpoint keyed by externalId', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'meeting-1', joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/x' }, 201));

    const result = await provider.createMeeting(INPUT);

    expect(result).toMatchObject({ externalId: 'meeting-1', joinUrl: 'https://teams.microsoft.com/l/meetup-join/x' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/onlineMeetings/createOrGet');
    expect(JSON.parse(init.body as string)).toMatchObject({ externalId: 'session-1-1700000000000' });
  });

  it('createMeeting treats 429 and 5xx as retryable (createOrGet makes the retry safe)', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': '2' }));
    const error = await provider.createMeeting(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableProviderError);
    expect((error as RetryableProviderError).retryAfterMs).toBe(2000);

    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(RetryableProviderError);

    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it('createMeeting maps 401 to reconnect-required', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));

    await expect(provider.createMeeting(INPUT)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('updateMeeting PATCHes subject and times', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: 'meeting-1' }));

    await provider.updateMeeting('tok', 'meeting-1', {
      topic: 'Algebra 101',
      startAt: INPUT.startAt,
      endAt: INPUT.endAt,
      timezone: 'Africa/Cairo',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/onlineMeetings/meeting-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({
      subject: 'Algebra 101',
      startDateTime: '2026-01-15T10:00:00.000Z',
      endDateTime: '2026-01-15T10:30:00.000Z',
    });
  });

  it('refresh: invalid_grant is reconnect-required, 5xx is retryable', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    await expect(provider.refresh('r')).rejects.toBeInstanceOf(UnauthorizedException);

    fetchMock.mockResolvedValueOnce(json({}, 500));
    await expect(provider.refresh('r')).rejects.toBeInstanceOf(RetryableProviderError);
  });

  it('deleteMeeting never throws', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 500));

    await expect(provider.deleteMeeting('tok', 'meeting-1')).resolves.toBeUndefined();
  });
});
