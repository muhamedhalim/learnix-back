import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Repository } from 'typeorm';

import { MeetingProvider } from '../entities/meeting-provider.enum';
import { TeacherMeetingAccount } from '../entities/teacher-meeting-account.entity';
import { TeacherMeetingAccountStatus } from '../entities/teacher-meeting-account-status.enum';
import { MeetingAccountsService } from './meeting-accounts.service';
import { MeetingProviderRegistry } from './meeting-provider-registry.service';
import type { MeetingProviderClient } from './providers/meeting-provider.interface';
import { RetryableProviderError } from './providers/provider-errors';

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

function fakeAccountsRepo(
  seed: TeacherMeetingAccount[] = [],
  options: { liveMeetings?: number } = {},
): Repository<TeacherMeetingAccount> {
  const rows = [...seed];
  let tail: Promise<unknown> = Promise.resolve();
  const repo = {
    findOne: jest.fn(({ where }: { where: Partial<TeacherMeetingAccount> }) =>
      Promise.resolve(
        rows.find(
          (row) => row.teacher_id === where.teacher_id && (!where.provider || row.provider === where.provider),
        ) ?? null,
      ),
    ),
    find: jest.fn(({ where }: { where: Partial<TeacherMeetingAccount> }) =>
      Promise.resolve(
        rows.filter((row) =>
          (Object.keys(where) as Array<keyof TeacherMeetingAccount>).every((key) => row[key] === where[key]),
        ),
      ),
    ),
    create: jest.fn((partial: Partial<TeacherMeetingAccount>) => ({ ...partial }) as TeacherMeetingAccount),
    save: jest.fn((row: TeacherMeetingAccount) => {
      const index = rows.findIndex((r) => r === row || (r.id && r.id === row.id));
      if (index >= 0) rows[index] = row;
      else rows.push(row);
      return Promise.resolve(row);
    }),
  };
  // `manager.transaction` serialises callers, standing in for the row lock the
  // real implementation takes (`pessimistic_write`).
  const manager = {
    transaction: jest.fn((work: (tx: unknown) => Promise<unknown>) => {
      const run = tail.then(() => work(manager));
      tail = run.catch(() => undefined);
      return run;
    }),
    findOne: jest.fn((_entity: unknown, { where }: { where: Partial<TeacherMeetingAccount> }) =>
      repo.findOne({ where }),
    ),
    save: jest.fn((row: TeacherMeetingAccount) => repo.save(row)),
    count: jest.fn(() => Promise.resolve(options.liveMeetings ?? 0)),
  };
  return { ...repo, manager } as unknown as Repository<TeacherMeetingAccount>;
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
    updateMeeting: jest.fn(),
    deleteMeeting: jest.fn(),
    ...overrides,
  };
}

describe('MeetingAccountsService', () => {
  const originalKey = process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
  beforeAll(() => {
    process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
    else process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = originalKey;
  });

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

    const { authorizeUrl, nonce } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    const state = new URL(authorizeUrl.replace('https://accounts.google.com/o?', 'https://x/?')).searchParams.get(
      'state',
    )!;

    const summary = await service.completeConnect(state, 'auth-code', nonce);
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
    const { authorizeUrl, nonce } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
    const state = new URL(authorizeUrl.replace('https://accounts.google.com/o?', 'https://x/?')).searchParams.get(
      'state',
    )!;

    await service.completeConnect(state, 'auth-code', nonce);
    await expect(service.completeConnect(state, 'auth-code', nonce)).rejects.toThrow(ConflictException);
  });

  it('connect: completeConnect rejects a malformed state', async () => {
    const registry = new MeetingProviderRegistry([fakeGoogleClient()]);
    const service = new MeetingAccountsService(fakeAccountsRepo(), registry, config(), fakeCache() as never);

    await expect(service.completeConnect('not-a-real-state', 'auth-code', 'n')).rejects.toThrow(
      BadRequestException,
    );
  });

  describe('browser binding, account switching and key availability (Unit C)', () => {
    const identity = (providerAccountId: string) => ({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: [],
      providerAccountId,
      providerAccountEmail: null,
      displayName: null,
    });

    function stateFrom(authorizeUrl: string): string {
      return new URL(authorizeUrl.replace('https://accounts.google.com/o?', 'https://x/?')).searchParams.get('state')!;
    }

    it('localeFromState returns the locale signed into the state, and undefined for junk', () => {
      const service = new MeetingAccountsService(
        fakeAccountsRepo(),
        new MeetingProviderRegistry([fakeGoogleClient()]),
        config(),
        fakeCache() as never,
      );
      const { authorizeUrl } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET, 'ar');
      const withoutLocale = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);

      expect(service.localeFromState(stateFrom(authorizeUrl))).toBe('ar');
      expect(service.localeFromState(stateFrom(withoutLocale.authorizeUrl))).toBeUndefined();
      expect(service.localeFromState('forged.state')).toBeUndefined();
    });

    it('rejects a callback whose browser has no binding cookie, without exchanging the code', async () => {
      const client = fakeGoogleClient({ exchangeCode: jest.fn().mockResolvedValue(identity('g-1')) });
      const service = new MeetingAccountsService(
        fakeAccountsRepo(),
        new MeetingProviderRegistry([client]),
        config(),
        fakeCache() as never,
      );
      const { authorizeUrl } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);

      await expect(service.completeConnect(stateFrom(authorizeUrl), 'code', undefined)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'MEETING_OAUTH_BINDING' }),
      });
      expect(client.exchangeCode).not.toHaveBeenCalled();
    });

    it('rejects a callback whose cookie belongs to a different handshake, and does not burn the real one', async () => {
      const client = fakeGoogleClient({ exchangeCode: jest.fn().mockResolvedValue(identity('g-1')) });
      const service = new MeetingAccountsService(
        fakeAccountsRepo(),
        new MeetingProviderRegistry([client]),
        config(),
        fakeCache() as never,
      );
      const { authorizeUrl, nonce } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);
      const state = stateFrom(authorizeUrl);

      await expect(service.completeConnect(state, 'code', 'attacker-nonce')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // The legitimate browser can still finish.
      await expect(service.completeConnect(state, 'code', nonce)).resolves.toMatchObject({ connected: true });
    });

    it('refuses to reconnect a DIFFERENT provider account while upcoming meetings exist on the old one', async () => {
      const existing = {
        teacher_id: TEACHER_ID,
        provider: MeetingProvider.GOOGLE_MEET,
        provider_account_id: 'old-account',
        status: TeacherMeetingAccountStatus.DISCONNECTED,
      } as TeacherMeetingAccount;
      const client = fakeGoogleClient({ exchangeCode: jest.fn().mockResolvedValue(identity('new-account')) });
      const service = new MeetingAccountsService(
        fakeAccountsRepo([existing], { liveMeetings: 2 }),
        new MeetingProviderRegistry([client]),
        config(),
        fakeCache() as never,
      );
      const { authorizeUrl, nonce } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);

      await expect(service.completeConnect(stateFrom(authorizeUrl), 'code', nonce)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'MEETING_ACCOUNT_MISMATCH' }),
      });
      expect(existing.provider_account_id).toBe('old-account');
    });

    it('allows switching accounts when no upcoming meetings depend on the old one, and re-connecting the same one', async () => {
      for (const [liveMeetings, accountId] of [
        [0, 'new-account'],
        [3, 'old-account'],
      ] as const) {
        const existing = {
          teacher_id: TEACHER_ID,
          provider: MeetingProvider.GOOGLE_MEET,
          provider_account_id: 'old-account',
          status: TeacherMeetingAccountStatus.EXPIRED,
        } as TeacherMeetingAccount;
        const client = fakeGoogleClient({ exchangeCode: jest.fn().mockResolvedValue(identity(accountId)) });
        const service = new MeetingAccountsService(
          fakeAccountsRepo([existing], { liveMeetings }),
          new MeetingProviderRegistry([client]),
          config(),
          fakeCache() as never,
        );
        const { authorizeUrl, nonce } = service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET);

        await expect(service.completeConnect(stateFrom(authorizeUrl), 'code', nonce)).resolves.toMatchObject({
          connected: true,
        });
        expect(existing.provider_account_id).toBe(accountId);
      }
    });

    it('startConnect reports the provider unavailable when the token-encryption key is missing or malformed', () => {
      const service = new MeetingAccountsService(
        fakeAccountsRepo(),
        new MeetingProviderRegistry([fakeGoogleClient()]),
        config(),
        fakeCache() as never,
      );
      const original = process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
      try {
        delete process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
        expect(() => service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET)).toThrow(NotFoundException);
        process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = 'not base64 !!';
        expect(() => service.startConnect(TEACHER_ID, MeetingProvider.GOOGLE_MEET)).toThrow(NotFoundException);
      } finally {
        process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = original;
      }
    });

    it('the registry reports every provider unconfigured without a usable key', () => {
      const registry = new MeetingProviderRegistry([fakeGoogleClient()]);
      const original = process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
      try {
        expect(registry.list().find((p) => p.provider === MeetingProvider.GOOGLE_MEET)?.configured).toBe(true);
        delete process.env['MEETING_TOKEN_ENCRYPTION_KEY'];
        expect(registry.list().every((p) => !p.configured)).toBe(true);
        expect(registry.isConnectable(MeetingProvider.GOOGLE_MEET)).toBe(false);
      } finally {
        process.env['MEETING_TOKEN_ENCRYPTION_KEY'] = original;
      }
    });

    it('serialises concurrent refreshes: two callers trigger exactly one provider refresh (single-use refresh tokens)', async () => {
      const account = {
        teacher_id: TEACHER_ID,
        provider: MeetingProvider.GOOGLE_MEET,
        status: TeacherMeetingAccountStatus.CONNECTED,
        access_token_encrypted: 'stale',
        refresh_token_encrypted: 'single-use',
        token_expires_at: new Date(Date.now() + 5_000),
      } as TeacherMeetingAccount;
      const refresh = jest.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { accessToken: 'fresh', refreshToken: 'rotated', expiresAt: new Date(Date.now() + 3600_000), scopes: [] };
      });
      const service = new MeetingAccountsService(
        fakeAccountsRepo([account]),
        new MeetingProviderRegistry([fakeGoogleClient({ refresh })]),
        config(),
        fakeCache() as never,
      );

      const [first, second] = await Promise.all([
        service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET),
        service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET),
      ]);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(first?.access_token_encrypted).toBe('fresh');
      expect(second?.access_token_encrypted).toBe('fresh');
      expect(account.status).toBe(TeacherMeetingAccountStatus.CONNECTED);
    });

    it('markRevokedByProviderAccount revokes matching connections, clears their tokens, and ignores unknown accounts', async () => {
      const account = {
        teacher_id: TEACHER_ID,
        provider: MeetingProvider.ZOOM,
        provider_account_id: 'zoom-user-1',
        status: TeacherMeetingAccountStatus.CONNECTED,
        access_token_encrypted: 'a',
        refresh_token_encrypted: 'r',
      } as TeacherMeetingAccount;
      const service = new MeetingAccountsService(
        fakeAccountsRepo([account]),
        new MeetingProviderRegistry([fakeGoogleClient()]),
        config(),
        fakeCache() as never,
      );

      await expect(service.markRevokedByProviderAccount(MeetingProvider.ZOOM, 'someone-else')).resolves.toBe(0);
      expect(account.status).toBe(TeacherMeetingAccountStatus.CONNECTED);

      await expect(service.markRevokedByProviderAccount(MeetingProvider.ZOOM, 'zoom-user-1')).resolves.toBe(1);
      expect(account.status).toBe(TeacherMeetingAccountStatus.REVOKED);
      expect(account.access_token_encrypted).toBeNull();
      expect(account.refresh_token_encrypted).toBeNull();
    });
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

  it('a transient refresh failure (429/5xx/timeout) rethrows and leaves the account connected', async () => {
    const account = {
      teacher_id: TEACHER_ID,
      provider: MeetingProvider.GOOGLE_MEET,
      status: TeacherMeetingAccountStatus.CONNECTED,
      access_token_encrypted: 'stale-access',
      refresh_token_encrypted: 'stale-refresh',
      token_expires_at: new Date(Date.now() + 10_000),
    } as TeacherMeetingAccount;
    const transient = new RetryableProviderError('token refresh failed with status 503', null, 503);
    const client = fakeGoogleClient({ refresh: jest.fn().mockRejectedValue(transient) });
    const repo = fakeAccountsRepo([account]);
    const service = new MeetingAccountsService(repo, new MeetingProviderRegistry([client]), config(), fakeCache() as never);

    await expect(service.getUsableAccount(TEACHER_ID, MeetingProvider.GOOGLE_MEET)).rejects.toBe(transient);
    expect(account.status).toBe(TeacherMeetingAccountStatus.CONNECTED);
    expect(repo.save).not.toHaveBeenCalled();
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
