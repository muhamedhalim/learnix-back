import type { Request, Response } from 'express';

import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from './auth-cookie.constants';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';

describe('AuthController session cookies', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const authService = {
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
  } as unknown as AuthService;
  const controller = new AuthController(authService);

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    jest.clearAllMocks();
  });

  it('sets production access and refresh credentials as Secure HttpOnly cookies only', async () => {
    process.env['NODE_ENV'] = 'production';
    (authService.login as jest.Mock).mockResolvedValue({
      status: 'approved',
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      role: 'student',
      userId: 'user-1',
    });
    const request = {
      headers: {},
      ip: '127.0.0.1',
      secure: true,
    } as unknown as Request;
    const response = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;

    const body = await controller.login(
      { email: 'student@example.com', password: 'Password123!' },
      request,
      response,
    );

    expect(body).toEqual({ status: 'approved', role: 'student', userId: 'user-1' });
    expect(JSON.stringify(body)).not.toContain('secret-access');
    expect(JSON.stringify(body)).not.toContain('secret-refresh');
    expect(response.cookie).toHaveBeenCalledWith(
      ACCESS_TOKEN_COOKIE,
      'secret-access',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        signed: true,
        partitioned: true,
        path: ACCESS_TOKEN_COOKIE_PATH,
      }),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      REFRESH_TOKEN_COOKIE,
      'secret-refresh',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        signed: true,
        partitioned: true,
        path: REFRESH_TOKEN_COOKIE_PATH,
      }),
    );
  });

  it('marks the CSRF bootstrap response as non-cacheable', () => {
    const response = { setHeader: jest.fn() } as unknown as Response;
    const result = controller.getCsrfToken(
      { csrfToken: 'csrf-token' } as unknown as Request,
      response,
    );

    expect(result.token).toBe('csrf-token');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
  });
});
