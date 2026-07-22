import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { Request, Response } from 'express';
import request from 'supertest';

import { ResponseLocalizationInterceptor } from '../common/interceptors/response-localization.interceptor';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from './auth-cookie.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

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

  it('uses secure cross-site cookies on proxied HTTPS even with a bad NODE_ENV', async () => {
    process.env['NODE_ENV'] = 'development';
    (authService.login as jest.Mock).mockResolvedValue({
      status: 'approved',
      accessToken: 'secret-access',
      refreshToken: 'secret-refresh',
      role: 'student',
      userId: 'user-1',
    });
    const response = { cookie: jest.fn(), clearCookie: jest.fn() } as unknown as Response;

    await controller.login(
      { email: 'student@example.com', password: 'Password123!' },
      { headers: {}, secure: true } as unknown as Request,
      response,
    );

    expect(response.cookie).toHaveBeenCalledWith(
      ACCESS_TOKEN_COOKIE,
      'secret-access',
      expect.objectContaining({ secure: true, sameSite: 'none', partitioned: true }),
    );
  });
});

/**
 * HTTP-level half of the user-enumeration regression suite (the service-level
 * half lives in auth.service.spec.ts). What matters here is the wire response:
 * an attacker never sees the service's return value, only a status line, a set
 * of headers, and a JSON body — all three of which must be identical for an
 * identifier that exists and one that does not.
 *
 * Boots the real controller behind the same global ValidationPipe and
 * ResponseLocalizationInterceptor that main.ts installs, so the assertions
 * cover the `@HttpCode(202)` decorator and the `message_ar` stripping rather
 * than a hand-rolled approximation of them.
 */
describe('POST /auth/register (user enumeration)', () => {
  let app: INestApplication;
  let server: Server;
  const register = jest.fn();

  const newIdentifier = {
    name: 'Ahmed Ali',
    email: 'brand-new@example.com',
    password: 'S3curePass',
    phone: '01000000000',
    requestedRole: 'student',
    parentPhone: '01011111111',
  };
  const takenIdentifier = { ...newIdentifier, email: 'already-there@example.com' };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: { register } }],
    })
      // The controller is decorated with @Throttle; without a ThrottlerGuard
      // registered globally (as in test-mode AppModule) the decorator is inert,
      // which is what lets this suite fire more than AUTH.limit requests.
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalInterceptors(new ResponseLocalizationInterceptor());
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // The service answers every non-malformed request with the same
    // acknowledgement — existing identifier, new identifier, or lost race.
    register.mockResolvedValue({
      message: 'Registration request received. Pending approval',
      message_ar: 'تم استلام طلب التسجيل. بانتظار الموافقة',
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('answers an existing and a brand-new identifier identically', async () => {
    const forNew = await request(server).post('/auth/register').send(newIdentifier);
    const forTaken = await request(server).post('/auth/register').send(takenIdentifier);

    expect(forNew.status).toBe(202);
    expect(forTaken.status).toBe(forNew.status);
    expect(forTaken.body).toEqual(forNew.body);
    expect(Object.keys(forTaken.body).sort()).toEqual(Object.keys(forNew.body).sort());
    expect(forTaken.headers['content-type']).toBe(forNew.headers['content-type']);
  });

  it('returns exactly { message } — no userId, no conflict signal', async () => {
    const response = await request(server).post('/auth/register').send(takenIdentifier);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      message: 'Registration request received. Pending approval',
    });
    expect(Object.keys(response.body)).toEqual(['message']);
    expect(response.text).not.toContain('userId');
  });

  it('never answers a registration attempt with 409 or 201', async () => {
    const response = await request(server).post('/auth/register').send(takenIdentifier);

    expect(response.status).not.toBe(409);
    expect(response.status).not.toBe(201);
  });

  it('still rejects a malformed payload with 400', async () => {
    const response = await request(server)
      .post('/auth/register')
      .send({ ...newIdentifier, email: 'not-an-email' });

    expect(response.status).toBe(400);
    expect(register).not.toHaveBeenCalled();
  });
});
