import { UnauthorizedException } from '@nestjs/common';

import { UserStatus } from '../../users/entities/user-status.enum';
import { HybridAuthGuard } from './hybrid-auth.guard';

/**
 * AUD-004 regression coverage.
 *
 * The Firebase bearer branch is a real, wired authentication path (the cookie
 * branch is the first-party frontend's; `Authorization: Bearer` is reserved for
 * Firebase ID-token clients). It used to publish the raw `User` entity onto the
 * request, while every controller reads `user.userId` through `@GetUser()` —
 * so a Firebase-authenticated caller reached handlers with no subject at all.
 */
describe('HybridAuthGuard — Firebase bearer branch', () => {
  const FIREBASE_TOKEN = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'firebase-key-1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: 'firebase-uid' })).toString('base64url'),
    'signature',
  ].join('.');

  function contextFor(request: Record<string, unknown>) {
    return { switchToHttp: () => ({ getRequest: () => request }) } as never;
  }

  function build(user: Record<string, unknown>) {
    const firebaseService = { verifyToken: jest.fn().mockResolvedValue({ uid: 'firebase-uid' }) };
    const usersService = { syncFirebaseUser: jest.fn().mockResolvedValue(user) };
    const guard = new HybridAuthGuard(
      firebaseService as never,
      usersService as never,
      {} as never,
      { get: () => 'test-secret' } as never,
    );
    return { guard, firebaseService, usersService };
  }

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

  it('publishes the JwtPayload contract (userId), not the raw User entity', async () => {
    const { guard } = build(approvedUser);
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${FIREBASE_TOKEN}` },
      signedCookies: {},
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    expect(request['user']).toEqual({
      userId: 'user-uuid-1',
      email: 'learner@example.com',
      name: 'Learner',
      role: 'student',
    });
  });

  it('exposes userId so ownership-scoped handlers receive a real subject', async () => {
    const { guard } = build(approvedUser);
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${FIREBASE_TOKEN}` },
      signedCookies: {},
    };

    await guard.canActivate(contextFor(request));

    const principal = request['user'] as { userId?: string };
    expect(principal.userId).toBe('user-uuid-1');
    expect(principal.userId).not.toBeUndefined();
  });

  it('does not leak entity-only fields such as the password hash onto the request', async () => {
    const { guard } = build(approvedUser);
    const request: Record<string, unknown> = {
      headers: { authorization: `Bearer ${FIREBASE_TOKEN}` },
      signedCookies: {},
    };

    await guard.canActivate(contextFor(request));

    expect(request['user']).not.toHaveProperty('password_hash');
    expect(request['user']).not.toHaveProperty('id');
  });

  it('still rejects a Firebase identity whose Learnix account is not approved', async () => {
    const { guard } = build({ ...approvedUser, status: UserStatus.PENDING });

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${FIREBASE_TOKEN}` }, signedCookies: {} }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still rejects a Firebase identity whose Learnix account is deactivated', async () => {
    const { guard } = build({ ...approvedUser, is_active: false });

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${FIREBASE_TOKEN}` }, signedCookies: {} }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still refuses an application JWT presented in the Authorization header', async () => {
    const { guard, firebaseService } = build(approvedUser);
    const appJwt = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'user-uuid-1' })).toString('base64url'),
      'signature',
    ].join('.');

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: `Bearer ${appJwt}` }, signedCookies: {} }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(firebaseService.verifyToken).not.toHaveBeenCalled();
  });

  it('still refuses a request carrying no credentials at all', async () => {
    const { guard } = build(approvedUser);

    await expect(
      guard.canActivate(contextFor({ headers: {}, signedCookies: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
