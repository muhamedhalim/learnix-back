import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FirebaseService } from '../../firebase/firebase.service';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../auth.service';
import { Request } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';

/**
 * Optional authentication guard that extracts user info when available
 * but does NOT require authentication.
 *
 * Use this for endpoints that should work for both:
 * - Unauthenticated users (public access)
 * - Authenticated users (with additional privileges)
 *
 * Example: Course details endpoint - for published courses,
 * but admin/creator can see unpublished courses.
 */
@Injectable()
export class OptionalHybridAuthGuard implements CanActivate {
  private readonly logger = new Logger(OptionalHybridAuthGuard.name);

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly usersService: UsersService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  private decodeJwtHeader(token: string): Record<string, unknown> | null {
    try {
      const part = token.split('.')[0];
      if (part === undefined || part === '') {
        return null;
      }
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const buff = Buffer.from(b64, 'base64');
      return JSON.parse(buff.toString()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async tryJwtVerify(
    token: string,
    request: Request,
  ): Promise<boolean> {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    if (jwtSecret === undefined || jwtSecret === '') {
      this.logger.debug('JWT_SECRET not configured, skipping JWT verification');
      return true;
    }

    let verified: JwtPayload | string;
    try {
      verified = jwt.verify(token, jwtSecret);
    } catch {
      this.logger.debug('JWT verification failed, continuing without auth');
      return true;
    }

    const payloadObj: JwtPayload | null =
      typeof verified === 'object' ? verified : null;

    // sub is now a UUID string
    const sub =
      payloadObj !== null &&
      'sub' in payloadObj &&
      typeof payloadObj.sub === 'string'
        ? payloadObj.sub
        : undefined;

    const email =
      payloadObj !== null && typeof payloadObj.email === 'string'
        ? payloadObj.email
        : undefined;

    if (sub === undefined || email === undefined) {
      this.logger.debug(
        'JWT payload missing required claims, continuing without auth',
      );
      return true;
    }

    try {
      const user = await this.authService.validateUser({ sub, email });
      if (user) {
        Object.assign(request, { user });
        this.logger.debug(`Optional auth: User ${user.userId} authenticated`);
      }
    } catch {
      this.logger.debug('User validation failed, continuing without auth');
    }

    return true;
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    // No auth header - allow request without user context
    if (authHeader?.startsWith('Bearer ') !== true) {
      this.logger.debug(
        'No auth header provided, continuing as unauthenticated',
      );
      return true;
    }

    const token = authHeader.split(' ')[1];
    if (token === undefined || token === '') {
      this.logger.debug('Empty token, continuing as unauthenticated');
      return true;
    }

    const header = this.decodeJwtHeader(token);

    // Non-Firebase token (no kid claim)
    if (header && !('kid' in header)) {
      this.logger.debug('Token has no kid claim, trying JWT verification');
      return await this.tryJwtVerify(token, request);
    }

    // Try Firebase verification first
    try {
      const decodedToken = await this.firebaseService.verifyToken(token);
      const user = await this.usersService.syncFirebaseUser(decodedToken);
      request.user = user;
      this.logger.debug(
        `Optional auth: Firebase user ${user.id} authenticated`,
      );
      return true;
    } catch {
      this.logger.debug('Firebase verification failed, trying JWT fallback');
      return await this.tryJwtVerify(token, request);
    }
  }
}
