import * as jwt from 'jsonwebtoken';

import { UserStatus } from '../../users/entities/user-status.enum';
import { ACCESS_TOKEN_COOKIE } from '../auth-cookie.constants';
import { OptionalHybridAuthGuard } from './optional-hybrid-auth.guard';

describe('OptionalHybridAuthGuard', () => {
  const enc = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const FIREBASE_TOKEN = [enc({ alg: 'RS256', kid: 'k' }), enc({ sub: 'f' }), 'sig'].join('.');
  const APP_TOKEN = [enc({ alg: 'HS256' }), enc({ sub: 'u' }), 'sig'].join('.');

  const approvedUser = {
    id: 'user-uuid-1',
    email: 'learner@example.com',
    name: 'Learner',
    role: 'student',
    is_active: true,
    status: UserStatus.APPROVED,
    firebase_uid: 'firebase-uid',
    password_hash: 'must-not-leak',
  };

  function build(user: Record<string, unknown>, validateUser = jest.fn()) {
    return new OptionalHybridAuthGuard(
      { verifyToken: jest.fn().mockResolvedValue({ uid: 'firebase-uid' }) } as never,
      { syncFirebaseUser: jest.fn().mockResolvedValue(user) } as never,
      { validateUser } as never,
      { get: () => 'test-secret' } as never,
    );
  }
  const ctx = (request: object) =>
    ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;
  const bearer = (token: string): Record<string, unknown> => ({
    headers: { authorization: `Bearer ${token}` },
    signedCookies: {},
  });

  it('publishes the JwtPayload shape (userId) and no entity-only fields', async () => {
    const request = bearer(FIREBASE_TOKEN);
    await expect(build(approvedUser).canActivate(ctx(request))).resolves.toBe(true);
    expect(request['user']).toEqual({
      userId: 'user-uuid-1',
      email: 'learner@example.com',
      name: 'Learner',
      role: 'student',
    });
  });

  it.each([
    ['inactive', { ...approvedUser, is_active: false }],
    ['unapproved', { ...approvedUser, status: UserStatus.PENDING }],
  ])('%s Firebase user stays anonymous and the guard returns true', async (_n, user) => {
    const request = bearer(FIREBASE_TOKEN);
    await expect(build(user).canActivate(ctx(request))).resolves.toBe(true);
    expect(request['user']).toBeUndefined();
  });

  it('ignores an application JWT supplied in the Authorization header', async () => {
    const request = bearer(APP_TOKEN);
    await expect(build(approvedUser).canActivate(ctx(request))).resolves.toBe(true);
    expect(request['user']).toBeUndefined();
  });

  it('cookie branch: validateUser null keeps the request anonymous', async () => {
    const token = jwt.sign({ sub: 'u1', email: 'a@b.c', sid: 's1' }, 'test-secret');
    const validateUser = jest.fn().mockResolvedValue(null);
    const request: Record<string, unknown> = {
      headers: {},
      signedCookies: { [ACCESS_TOKEN_COOKIE]: token },
    };
    await expect(build(approvedUser, validateUser).canActivate(ctx(request))).resolves.toBe(true);
    expect(validateUser).toHaveBeenCalled();
    expect(request['user']).toBeUndefined();
  });
});
