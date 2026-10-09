import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Request } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';

import { FirebaseService } from '../../firebase/firebase.service';
import type { JwtPayload as AppJwtPayload } from '../../common/interfaces/user-request.interface';
import { UserStatus } from '../../users/entities/user-status.enum';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../auth.service';
import { ACCESS_TOKEN_COOKIE } from '../auth-cookie.constants';
import { isInfrastructureError } from '../infrastructure-error.util';

@Injectable()
export class HybridAuthGuard implements CanActivate {
  private readonly logger = new Logger(HybridAuthGuard.name);

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private decodeJwtHeader(token: string): Record<string, unknown> | null {
    try {
      const part = token.split('.')[0];

      // FIX 2: Check for 'part' in case of strict TS rules (noUncheckedIndexedAccess)
      if (part === undefined || part === '') {
        this.logger.debug('Failed to get first part of JWT.');
        return null;
      }

      const b64 = part.replaceAll('-', '+').replaceAll('_', '/');
      const buff = Buffer.from(b64, 'base64');
      const parsed = JSON.parse(buff.toString()) as Record<string, unknown>;
      return parsed;
    } catch {
      // FIX 1: Removed unused '_parseErr' variable
      // intentionally not noisy for malformed tokens
      this.logger.debug('Failed to decode JWT header.');
      return null;
    }
  }

  private verifyJwtSecret(): string {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    if (jwtSecret === undefined || jwtSecret === '') {
      this.logger.error('JWT_SECRET not configured');
      throw new Error('JWT_SECRET not configured');
    }
    return jwtSecret;
  }

  private extractJwtPayload(token: string, jwtSecret: string): JwtPayload {
    let verified: JwtPayload | string;
    try {
      verified = jwt.verify(token, jwtSecret);
    } catch (error) {
      this.logger.warn(
        `JWT verification threw an error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new UnauthorizedException('Invalid authentication token');
    }

    const payloadObj: JwtPayload | null = typeof verified === 'object' ? verified : null;

    if (!payloadObj) {
      this.logger.warn('JWT payload is not an object');
      throw new UnauthorizedException('Invalid token payload');
    }

    return payloadObj;
  }

  private validatePayloadClaims(payloadObj: JwtPayload): {
    sub: string;
    email: string;
    sid: string;
  } {
    const sub =
      'sub' in payloadObj && typeof payloadObj.sub === 'string' ? payloadObj.sub : undefined;

    const email = typeof payloadObj['email'] === 'string' ? payloadObj['email'] : undefined;
    const sid = typeof payloadObj['sid'] === 'string' ? payloadObj['sid'] : undefined;

    if (
      sub === undefined ||
      sub === '' ||
      email === undefined ||
      email === '' ||
      sid === undefined ||
      sid === ''
    ) {
      this.logger.warn('JWT payload is missing required session claims.');
      throw new UnauthorizedException('Invalid token payload');
    }

    return { sub, email, sid };
  }

  private async tryJwtVerify(token: string, request: Request): Promise<boolean> {
    const jwtSecret = this.verifyJwtSecret();
    const payloadObj = this.extractJwtPayload(token, jwtSecret);
    const validateParams = this.validatePayloadClaims(payloadObj);

    try {
      const user = await this.authService.validateUser(validateParams);
      if (user === null) {
        this.logger.warn('JWT verified but user not found or inactive');
        throw new UnauthorizedException('User not found or inactive');
      }
      Object.assign(request, { user });
      return true;
    } catch (error) {
      this.logger.warn(
        `AuthService.validateUser failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (isInfrastructureError(error)) {
        throw new ServiceUnavailableException('Authentication service temporarily unavailable');
      }
      throw new UnauthorizedException('Invalid authentication token');
    }
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const cookieToken = request.signedCookies?.[ACCESS_TOKEN_COOKIE];
    if (typeof cookieToken === 'string' && cookieToken !== '') {
      return await this.tryJwtVerify(cookieToken, request);
    }

    const authHeader = request.headers.authorization;

    if (authHeader?.startsWith('Bearer ') !== true) {
      throw new UnauthorizedException('No authentication token provided');
    }

    const token = authHeader.split(' ')[1];

    if (token === undefined || token === '') {
      throw new UnauthorizedException('Malformed authorization header');
    }

    // Inspect token header
    const header = this.decodeJwtHeader(token);
    if (header) {
      this.logger.debug(`Auth token header: ${JSON.stringify(header)}`);
    } else {
      this.logger.debug('Unable to decode auth token header');
    }

    // Bearer credentials are retained only for Firebase ID-token clients.
    if (header && !('kid' in header)) {
      this.logger.debug('Rejected application JWT in Authorization header; cookie required.');
      throw new UnauthorizedException('Application access token cookie is required');
    }

    // Otherwise, try Firebase verification first (for regular users)
    try {
      const decodedToken = await this.firebaseService.verifyToken(token);
      const user = await this.usersService.syncFirebaseUser(decodedToken);
      if (!user.is_active || user.status !== UserStatus.APPROVED) {
        throw new UnauthorizedException('User account is not approved or active');
      }
      // Publish the SAME principal shape the cookie/JWT branch publishes
      // (`JwtPayload`), not the raw `User` entity. Controllers read
      // `user.userId` in ~338 places via `@GetUser()`; an entity exposes `id`
      // and no `userId`, so a Firebase-authenticated request used to reach
      // handlers with `userId === undefined` — `GET /users/me` answered 403 and
      // ownership-scoped queries were handed an undefined subject. The identity
      // checks above are unchanged; only the shape handed downstream is fixed.
      // `sessionId` is deliberately absent: a Firebase bearer client holds no
      // Learnix session row, and `JwtPayload.sessionId` is optional for exactly
      // this case (its two readers already default it to `null`).
      Object.assign(request, {
        user: {
          userId: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        } satisfies AppJwtPayload,
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Firebase verification failed: ${error instanceof Error ? error.message : String(error)}.`,
      );

      if (isInfrastructureError(error)) {
        throw new ServiceUnavailableException('Authentication service temporarily unavailable');
      }
      throw new UnauthorizedException('Invalid authentication token');
    }
  }
}
