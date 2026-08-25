import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Repository } from 'typeorm';

import { MeetingProvider } from '../entities/meeting-provider.enum';
import { TeacherMeetingAccount } from '../entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountStatus } from '../entities/teacher-meeting-account-status.enum';
import { MeetingAccountsService } from './meeting-accounts.service';
import { MeetingProviderRegistry } from './meeting-provider-registry.service';
import type { MeetingProviderClient } from './providers/meeting-provider.interface';

const TEACHER_ID = 'teacher-1';

function config(): ConfigService {
  const values: Record<string, string> = {
    JWT_SECRET: 'a'.repeat(32),
    BACKEND_URL: 'https://api.example.test',
  };
  return { get: (key: string) => values[key] } as ConfigService;
}

function fakeCache(): { get: jest.Mock; set: jest.Mock } {
  const store = new Map<string, unknown>();
  return {
    get: jest.fn((key: string) => Promise.resolve(store.get(key))),
    set: jest.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
}

function fakeAccountsRepo(seed: TeacherMeetingAccount[] = []): Repository<TeacherMeetingAccount> {
  const rows = [...seed];
  return {
    findOne: jest.fn(({ where }: { where: Partial<TeacherMeetingAccount> }) =>
      Promise.resolve(
        rows.find(
          (row) => row.teacher_id === where.teacher_id && (!where.provider || row.provider === where.provider),
        ) ?? null,
      ),
    ),
    find: jest.fn(({ where }: { where: Partial<TeacherMeetingAccount> }) =>
      Promise.resolve(rows.filter((row) => row.teacher_id === where.teacher_id)),
    ),
    create: jest.fn((partial: Partial<TeacherMeetingAccount>) => ({ ...partial }) as TeacherMeetingAccount),
    save: jest.fn((row: TeacherMeetingAccount) => {
      const index = rows.findIndex((r) => r === row || (r.id && r.id === row.id));
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      return Promise.resolve(row);
    }),
  } as unknown as Repository<TeacherMeetingAccount>;
}

function fakeGoogleClient(overrides: Partial<MeetingProviderClient> = {}): MeetingProviderClient {
  return {
    name: MeetingProvider.GOOGLE_MEET,
    isConfigured: () => true,
    getConfigurationStatus: () => ({ enabled: true, configured: true }),
    buildAuthorizeUrl: (state: string) => `https://accounts.google.com/o?state=${state}`,
    exchangeCode: jest.fn(),
    refresh: jest.fn(),
    revoke: jest.fn(),
    createMeeting: jest.fn(),
    deleteMeeting: jest.fn(),
    ...overrides,
  };
}

describe('MeetingAccountsService', () => {
  it('connect: startConnect returns an authorize URL for a configured provider', () => {
    const registry = new MeetingProviderRegistry([fakeGoogleClient()]);
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, config(), fakeCache() as never);

    const { authorizeUrl } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    expect(authorizeUrl).toContain('https://accounts.google.com/o?state=');
  });

  it('connect: startConnect threads a well-formed MEETING_OAUTH_REDIRECT_BASE_URL override through as the redirect_uri (Phase 9)', () => {
    const client = fakeGoogleClient({
      buildAuthorizeUrl: (state: string, redirectUri: string) =>
        `https://accounts.google.com/o?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    });
    const registry = new MeetingProviderRegistry([client]);
    const overrideConfig = {
      get: (key: string) =>
        ({ JWT_SECRET: 'a'.repeat(32), BACKEND_URL: 'https://api.example.test', MEETING_OAUTH_REDIRECT_BASE_URL: 'https://oauth.example.test' } as Record<string, string>)[key],
    } as ConfigService;
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, overrideConfig, fakeCache() as never);

    const { authorizeUrl } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);

    expect(authorizeUrl).toContain(
      encodeURIComponent('https://oauth.example.test/api/v1/teacher/meeting-accounts/callback'),
    );
  });

  it('connect: startConnect rejects a malformed MEETING_OAUTH_REDIRECT_BASE_URL rather than silently using it (Phase 9 SSRF hardening)', () => {
    const registry = new MeetingProviderRegistry([fakeGoogleClient()]);
    const malformedConfig = {
      get: (key: string) =>
        ({
          JWT_SECRET: 'a'.repeat(32),
          BACKEND_URL: 'https://api.example.test',
          // A path is not a bare origin — parsePublicOrigin must reject it.
          MEETING_OAUTH_REDIRECT_BASE_URL: 'https://oauth.example.test/some/path',
        } as Record<string, string>)[key],
    } as ConfigService;
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, malformedConfig, fakeCache() as never);

    expect(() => service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET)).toThrow();
  });

  it('connect: startConnect rejects an unconfigured provider', () => {
    const registry = new MeetingProviderRegistry([fakeGoogleClient({ isConfigured: () => false })]);
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, config(), fakeCache() as never);

    expect(() => service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET)).toThrow(NotFoundException);
  });

  it('connect: completeConnect persists tokens and identity from a successful exchange', async () => {
    const client = fakeGoogleClient({
      exchangeCode: jest.fn().mockResolvedValue({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: ['calendar.events'],
        providerAccountId: 'g-123',
        providerAccountEmail: 'teacher@example.test',
        displayName: 'Teacher',
      }),
    });
    const registry = new MeetingProviderRegistry([client]);
    const cache = fakeCache();
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, config(), cache as never);

    const { authorizeUrl } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    const state = new URL(authorizeUrl.replace('https://accounts.google.com/o?', 'https://x/?')).searchParams.get(
      'state',
    )!;

    const summary = await service.completeConnect(state, 'auth-code');
    expect(summary.connected).toBe(true);
    expect(summary.status).toBe(TeacherMeetingAccountStatus.CONNECTED);
    expect(summary.accountEmail).toBe('teacher@example.test');
    expect(client.exchangeCode).toHaveBeenCalledWith('auth-code', expect.any(String));
  });

  it('connect: completeConnect rejects a replayed state (single-use)', async () => {
    const client = fakeGoogleClient({
      exchangeCode: jest.fn().mockResolvedValue({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: [],
        providerAccountId: 'g-123',
        providerAccountEmail: null,
        displayName: null,
      }),
    });
    const registry = new MeetingProviderRegistry([client]);
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, config(), fakeCache() as never);
    const { authorizeUrl } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    const state = new URL(authorizeUrl.replace('https://accounts.google.com/o?', 'https://x/?')).searchParams.get(
      'state',
    )!;

    await service.completeConnect(state, 'auth-code');
    await expect(service.completeConnect(state, 'auth-code')).rejects.toThrow(ConflictException);
  });

  it('connect: completeConnect rejects a malformed state', async () => {
    const registry = new MeetingProviderRegistry([fakeGoogleClient()]);
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, config(), fakeCache() as never);

    await expect(service.completeConnect('not-a-real-state', 'auth-code')).rejects.toThrow(BadRequestException);
  });

  it('refresh: getUsableAccount returns the existing account untouched when the token is not expiring soon', async () => {
    const account = {
      teacher_id: TEACHER_ID,
      provider: MeetingProvider.GOOGLE_MEET,
      status: TeacherMeetingAccountStatus.CONNECTED,
      access_token_encrypted: 'access-1',
      refresh_token_encrypted: 'refresh-1',
      token_expires_at: new Date(Date.now() + 3600_000),
    } as TeacherMeetingAccount;
    const client = fakeGoogleClient();
    const registry = new MeetingProviderRegistry([client]);
    const service = new MeetingAccountsService(fakeAccountsRepo([account]), registry, config(), fakeCache() as never);

    const result = await service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    expect(result).toBe(account);
    expect(client.refresh).not.toHaveBeenCalled();
  });

  it('refresh: getUsableAccount proactively refreshes an expiring token and persists a rotated refresh token', async () => {
    const account = {
      teacher_id: TEACHER_ID,
      provider: MeetingProvider.GOOGLE_MEET,
      status: TeacherMeetingAccountStatus.CONNECTED,
      access_token_encrypted: 'stale-access',
      refresh_token_encrypted: 'stale-refresh',
      token_expires_at: new Date(Date.now() + 10_000),
    } as TeacherMeetingAccount;
    const client = fakeGoogleClient({
      refresh: jest.fn().mockResolvedValue({
        accessToken: 'fresh-access',
        refreshToken: 'rotated-refresh',
        expiresAt: new Date(Date.now() + 3600_000),
        scopes: [],
      }),
    });
    const registry = new MeetingProviderRegistry([client]);
    const service = new MeetingAccountsService(fakeAccountsRepo([account]), registry, config(), fakeCache() as never);

    const result = await service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    expect(result?.access_token_encrypted).toBe('fresh-access');
    expect(result?.refresh_token_encrypted).toBe('rotated-refresh');
    expect(result?.status).toBe(TeacherMeetingAccountStatus.CONNECTED);
  });

  it('invalid_grant -> revoked: a refresh failing with UnauthorizedException marks the account revoked, not expired', async () => {
    const account = {
      teacher_id: TEACHER_ID,
      provider: MeetingProvider.GOOGLE_MEET,
      status: TeacherMeetingAccountStatus.CONNECTED,
      access_token_encrypted: 'stale-access',
      refresh_token_encrypted: 'stale-refresh',
      token_expires_at: new Date(Date.now() + 10_000),
    } as TeacherMeetingAccount;
    const client = fakeGoogleClient({
      refresh: jest.fn().mockRejectedValue(new UnauthorizedException('reconnect required')),
    });
    const registry = new MeetingProviderRegistry([client]);
    const repo = fakeAccountsRepo([account]);
    const service = new MeetingAccountsService(repo, registry, config(), fakeCache() as never);

    const result = await service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    expect(result).toBeNull();
    expect(account.status).toBe(TeacherMeetingAccountStatus.REVOKED);
  });

  it('an ordinary (non-auth) refresh failure marks the account expired, not revoked', async () => {
    const account = {
      teacher_id: TEACHER_ID,
      provider: MeetingProvider.GOOGLE_MEET,
      status: TeacherMeetingAccountStatus.CONNECTED,
      access_token_encrypted: 'stale-access',
      refresh_token_encrypted: 'stale-refresh',
      token_expires_at: new Date(Date.now() + 10_000),
    } as TeacherMeetingAccount;
    const client = fakeGoogleClient({
      refresh: jest.fn().mockRejectedValue(new Error('network timeout')),
    });
    const registry = new MeetingProviderRegistry([client]);
    const service = new MeetingAccountsService(fakeAccountsRepo([account]), registry, config(), fakeCache() as never);

    const result = await service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    expect(result).toBeNull();
    expect(account.status).toBe(TeacherMeetingAccountStatus.EXPIRED);
  });
});
