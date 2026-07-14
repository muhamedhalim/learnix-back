import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Request } from 'express';
import * as jwt from 'jsonwebtoken';

import type { FirebaseService } from '../../firebase/firebase.service';
import type { UsersService } from '../../users/users.service';
import type { AuthService } from '../auth.service';
import { ACCESS_TOKEN_COOKIE } from '../auth-cookie.constants';
import { HybridAuthGuard } from './hybrid-auth.guard';

const secret = 'test-jwt-secret-value-at-least-32-characters';

function contextFor(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('HybridAuthGuard cookie sessions', () => {
  const firebaseService = { verifyToken: jest.fn() } as unknown as FirebaseService;
  const usersService = { syncFirebaseUser: jest.fn() } as unknown as UsersService;
  const authService = {
    validateUser: jest.fn().mockResolvedValue({
      userId: 'user-1',
      email: 'student@example.com',
      name: 'Student',
      role: 'student',
      sessionId: 'session-1',
    }),
  } as unknown as AuthService;
  const configService = {
    get: jest.fn((key: string) => (key === 'JWT_SECRET' ? secret : undefined)),
  } as unknown as ConfigService;

  const guard = new HybridAuthGuard(firebaseService, usersService, authService, configService);

  it('authenticates an application JWT only from the signed HttpOnly-cookie slot', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'student@example.com', sid: 'session-1' },
      secret,
      { expiresIn: '15m' },
    );
    const request = { signedCookies: { [ACCESS_TOKEN_COOKIE]: token }, headers: {} } as Request;

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ userId: 'user-1', sessionId: 'session-1' });
  });

  it('rejects a custom application JWT supplied as a Bearer credential', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'student@example.com', sid: 'session-1' },
      secret,
      { expiresIn: '15m' },
    );
    const request = { signedCookies: {}, headers: { authorization: `Bearer ${token}` } } as Request;

    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
