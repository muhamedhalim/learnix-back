import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';

import { FirebaseService } from '../../firebase/firebase.service';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../auth.service';

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

      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
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
    } catch (verifyErr) {
      this.logger.warn(
        `JWT verification threw an error: ${
          verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
        }`,
      );
      throw new UnauthorizedException('Invalid authentication token');
    }

    const payloadObj: JwtPayload | null =
      typeof verified === 'object' ? verified : null;

    if (!payloadObj) {
      this.logger.warn('JWT payload is not an object');
      throw new UnauthorizedException('Invalid token payload');
    }

    return payloadObj;
  }

  private validatePayloadClaims(payloadObj: JwtPayload): {
    sub: string;
    email: string;
  } {
    const sub =
      'sub' in payloadObj && typeof payloadObj.sub === 'string'
        ? payloadObj.sub
        : undefined;

    const email =
      typeof payloadObj['email'] === 'string' ? payloadObj['email'] : undefined;

    if (
      sub === undefined ||
      sub === '' ||
      email === undefined ||
      email === ''
    ) {
      this.logger.warn(
        'JWT payload is missing required "sub" or "email" claims.',
      );
      throw new UnauthorizedException('Invalid token payload');
    }

    return { sub, email };
  }

  private async tryJwtVerify(
    token: string,
    request: Request,
  ): Promise<boolean> {
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
    } catch (validateErr) {
      this.logger.warn(
        `AuthService.validateUser failed: ${
          validateErr instanceof Error
            ? validateErr.message
            : String(validateErr)
        }`,
      );
      throw new UnauthorizedException('Invalid authentication token');
    }
  }

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
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

    // If token header exists but has no `kid`, treat it as non-Firebase ID token
    if (header && !('kid' in header)) {
      this.logger.warn(
        'Auth token header has no "kid" claim — skipping Firebase verification and trying JWT.',
      );
      return await this.tryJwtVerify(token, request);
    }

    // Otherwise, try Firebase verification first (for regular users)
    try {
      const decodedToken = await this.firebaseService.verifyToken(token);
      const user = await this.usersService.syncFirebaseUser(decodedToken);
      Object.assign(request, { user });
      return true;
    } catch (firebaseErr) {
      // Log details and fall back to JWT
      this.logger.warn(
        `Firebase verification failed: ${
          firebaseErr instanceof Error
            ? firebaseErr.message
            : String(firebaseErr)
        } — falling back to JWT verification.`,
      );

      // Try JWT authentication (for admin / fallback)
      return await this.tryJwtVerify(token, request);
    }
  }
}
