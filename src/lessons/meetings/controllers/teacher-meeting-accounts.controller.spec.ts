import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { Request, Response } from 'express';

import { MeetingProvider } from '../../entities/meeting-provider.enum';
import type { MeetingAccountsService } from '../meeting-accounts.service';
import { MEETING_OAUTH_COOKIE, TeacherMeetingAccountsController } from './teacher-meeting-accounts.controller';

const USER = { userId: 'teacher-1' } as never;

describe('TeacherMeetingAccountsController OAuth browser binding', () => {
  const accounts = {
    startConnect: jest.fn(),
    completeConnect: jest.fn(),
    localeFromState: jest.fn(),
  };
  const config = {
    get: (key: string) =>
      ({ FRONTEND_URL: 'https://learn.example.test', BACKEND_URL: 'https://api.example.test' } as Record<string, string>)[
        key
      ],
  } as unknown as ConfigService;
  const controller = new TeacherMeetingAccountsController(accounts as unknown as MeetingAccountsService, config);

  function response() {
    return { cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn() };
  }
  const asRes = (res: ReturnType<typeof response>) => res as unknown as Response;
  const req = (signedCookies: Record<string, unknown> = {}, secure = true) =>
    ({ signedCookies, secure }) as unknown as Request;

  beforeEach(() => jest.clearAllMocks());

  it('connect binds the handshake nonce to the browser in a signed, HttpOnly, Lax cookie scoped to the route', () => {
    accounts.startConnect.mockReturnValue({ authorizeUrl: 'https://accounts.google.com/o?state=s', nonce: 'nonce-1' });
    const res = response();

    const result = controller.connect(USER, MeetingProvider.GOOGLE_MEET, {}, req(), asRes(res));

    expect(result).toEqual({ authorize_url: 'https://accounts.google.com/o?state=s' });
    expect(accounts.startConnect).toHaveBeenCalledWith('teacher-1', MeetingProvider.GOOGLE_MEET, undefined);
    expect(res.cookie).toHaveBeenCalledWith(
      MEETING_OAUTH_COOKIE,
      'nonce-1',
      expect.objectContaining({
        httpOnly: true,
        signed: true,
        sameSite: 'lax',
        secure: true,
        path: '/api/v1/teacher/meeting-accounts',
      }),
    );
  });

  it('connect forwards the UI locale into the signed handshake', () => {
    accounts.startConnect.mockReturnValue({ authorizeUrl: 'https://x', nonce: 'n' });

    controller.connect(USER, MeetingProvider.ZOOM, { locale: 'ar' }, req(), asRes(response()));

    expect(accounts.startConnect).toHaveBeenCalledWith('teacher-1', MeetingProvider.ZOOM, 'ar');
  });

  it('callback lands the teacher back in their locale (prefixed for ar, unprefixed for en)', async () => {
    accounts.completeConnect.mockResolvedValue({ provider: MeetingProvider.GOOGLE_MEET });
    for (const [locale, prefix] of [
      ['ar', '/ar'],
      ['en', ''],
      [undefined, ''],
      ['fr', ''],
    ] as const) {
      accounts.localeFromState.mockReturnValue(locale);
      const res = response();
      await controller.callback('state', 'code', undefined, req({ [MEETING_OAUTH_COOKIE]: 'n' }), asRes(res));
      expect(res.redirect).toHaveBeenCalledWith(
        `https://learn.example.test${prefix}/teacher/integrations?meeting_connect=success&provider=google_meet`,
      );
    }
  });

  it('callback passes the browser cookie to completeConnect, clears it, and redirects with success', async () => {
    accounts.completeConnect.mockResolvedValue({ provider: MeetingProvider.GOOGLE_MEET });
    const res = response();

    await controller.callback('state', 'code', undefined, req({ [MEETING_OAUTH_COOKIE]: 'nonce-1' }), asRes(res));

    expect(accounts.completeConnect).toHaveBeenCalledWith('state', 'code', 'nonce-1');
    expect(res.clearCookie).toHaveBeenCalledWith(MEETING_OAUTH_COOKIE, expect.objectContaining({ path: expect.any(String) }));
    expect(res.redirect).toHaveBeenCalledWith(
      'https://learn.example.test/teacher/integrations?meeting_connect=success&provider=google_meet',
    );
  });

  it('callback from a browser with no binding cookie is rejected with reason=binding', async () => {
    accounts.completeConnect.mockRejectedValue(
      new BadRequestException({ message: 'x', code: 'MEETING_OAUTH_BINDING' }),
    );
    const res = response();

    await controller.callback('state', 'code', undefined, req({}), asRes(res));

    expect(accounts.completeConnect).toHaveBeenCalledWith('state', 'code', undefined);
    expect(res.redirect).toHaveBeenCalledWith(
      'https://learn.example.test/teacher/integrations?meeting_connect=error&reason=binding',
    );
  });

  it('callback surfaces distinct, non-sensitive failure reasons', async () => {
    const cases: Array<[unknown, string]> = [
      [new ConflictException({ message: 'x', code: 'MEETING_ACCOUNT_MISMATCH' }), 'mismatch'],
      [new ConflictException('replay'), 'replay'],
      [new BadRequestException('expired'), 'invalid'],
      [new Error('boom with secret token abc'), 'failed'],
    ];
    for (const [error, reason] of cases) {
      accounts.completeConnect.mockRejectedValueOnce(error);
      const res = response();
      await controller.callback('state', 'code', undefined, req({ [MEETING_OAUTH_COOKIE]: 'n' }), asRes(res));
      expect(res.redirect).toHaveBeenCalledWith(
        `https://learn.example.test/teacher/integrations?meeting_connect=error&reason=${reason}`,
      );
    }
  });

  it('callback reports a provider-side denial without exchanging anything', async () => {
    const res = response();

    await controller.callback('state', '', 'access_denied', req({ [MEETING_OAUTH_COOKIE]: 'n' }), asRes(res));

    expect(accounts.completeConnect).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://learn.example.test/teacher/integrations?meeting_connect=error&reason=denied',
    );
  });
});
