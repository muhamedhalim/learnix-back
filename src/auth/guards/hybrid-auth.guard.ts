import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { FirebaseService } from '../../firebase/firebase.service';
import { UsersService } from '../../users/users.service';
import { AuthService } from '../auth.service';
import * as jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';

@Injectable()
export class HybridAuthGuard implements CanActivate {
  private readonly logger = new Logger(HybridAuthGuard.name);

  constructor(
    private firebaseService: FirebaseService,
    private usersService: UsersService,
    private authService: AuthService,
    private configService: ConfigService,
  ) {}

  private decodeJwtHeader(token: string): Record<string, unknown> | null {
    try {
      const part = token.split('.')[0];

      // FIX 2: Check for 'part' in case of strict TS rules (noUncheckedIndexedAccess)
      if (!part) {
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

  private async tryJwtVerify(
    token: string,
    request: Request,
  ): Promise<boolean> {
    const jwtSecret = this.configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      this.logger.error('JWT_SECRET not configured');
      throw new Error('JWT_SECRET not configured');
    }

    let verified: JwtPayload | string;
    try {
      // jwt.verify returns string | JwtPayload
      verified = jwt.verify(token, jwtSecret);
    } catch (verifyErr) {
      // use the error in the log so it's not "defined but never used"
      this.logger.warn(
        `JWT verification threw an error: ${
          verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
        }`,
      );
      throw new UnauthorizedException('Invalid authentication token');
    }

    // Normalize payload into a typed object we can safely read
    const payloadObj: JwtPayload | undefined =
      typeof verified === 'object' && verified !== null ? verified : undefined;

    const sub =
      payloadObj && 'sub' in payloadObj
        ? typeof payloadObj.sub === 'number'
          ? payloadObj.sub
          : parseInt(String(payloadObj.sub), 10)
        : undefined;

    const email =
      payloadObj && typeof payloadObj.email === 'string'
        ? payloadObj.email
        : undefined;

    // FIX 3: Check if we have the required params BEFORE building the object.
    // The error indicates 'validateUser' requires BOTH sub and email.
    if (typeof sub !== 'number' || Number.isNaN(sub) || !email) {
      this.logger.warn(
        'JWT payload is missing required "sub" or "email" claims.',
      );
      throw new UnauthorizedException('Invalid token payload');
    }

    // Now TS knows 'sub' is a number and 'email' is a string
    const validateParams = { sub: sub, email: email };

    try {
      // This call is now valid as validateParams matches { sub: number, email: string }
      const user = await this.authService.validateUser(validateParams);
      if (!user) {
        this.logger.warn('JWT verified but user not found or inactive');
        throw new UnauthorizedException('User not found or inactive');
      }
      request.user = user;
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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No authentication token provided');
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
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
      return this.tryJwtVerify(token, request);
    }

    // Otherwise, try Firebase verification first (for regular users)
    try {
      const decodedToken = await this.firebaseService.verifyToken(token);
      const user = await this.usersService.syncFirebaseUser(decodedToken);
      request.user = user;
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
      return this.tryJwtVerify(token, request);
    }
  }
}
