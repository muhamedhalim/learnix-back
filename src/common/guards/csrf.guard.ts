import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import * as crypto from 'crypto';
import { Request, Response } from 'express';

/**
 * CSRF Guard implementing Double Submit Cookie pattern
 *
 * Modern 2025 approach (csurf is deprecated):
 * - Generates a random CSRF token and stores it in a signed cookie
 * - Requires the same token to be sent in X-CSRF-Token header
 * - Validates tokens match on all state-changing requests (POST/PUT/DELETE/PATCH)
 * - GET/HEAD/OPTIONS requests are exempt
 *
 * Security layers:
 * 1. SameSite=Lax cookies (primary defense)
 * 2. Double Submit Cookie pattern (secondary defense)
 * 3. Signed cookies to prevent tampering
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);
  private readonly csrfCookieName = 'XSRF-TOKEN';
  private readonly csrfHeaderName = 'x-csrf-token';
  private readonly tokenLength = 32; // 256 bits

  constructor(private readonly reflector: Reflector) {}

  /**
   * Generates a cryptographically secure random CSRF token
   */
  private generateToken(): string {
    return crypto.randomBytes(this.tokenLength).toString('hex');
  }

  /**
   * Validates CSRF token for state-changing requests
   */
  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const method = request.method.toUpperCase();

    // Check if CSRF is disabled for this route via @SkipCsrf() decorator
    const skipCsrf = this.reflector.get<boolean>(
      'skipCsrf',
      context.getHandler(),
    );

    if (skipCsrf) {
      this.logger.debug(`CSRF check skipped for ${method} ${request.url}`);
      return true;
    }

    // GET, HEAD, OPTIONS are safe methods - no CSRF check needed
    // But we still generate and set the cookie for future requests
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      this.ensureCsrfCookie(request, response);
      return true;
    }

    // For state-changing methods (POST, PUT, DELETE, PATCH), validate token
    // Read from signedCookies (cookies signed with COOKIE_SECRET)
    const cookieToken = request.signedCookies[this.csrfCookieName] as
      | string
      | undefined;
    const headerToken = request.headers[this.csrfHeaderName] as
      | string
      | undefined;

    // Log for debugging (remove in production)
    this.logger.debug(
      `CSRF validation for ${method} ${request.url}: cookie=${String(cookieToken !== undefined)}, header=${String(headerToken !== undefined)}`,
    );

    // Both tokens must be present
    if (
      cookieToken === undefined ||
      cookieToken === '' ||
      headerToken === undefined ||
      headerToken === ''
    ) {
      this.logger.warn(
        `CSRF token missing for ${method} ${request.url} from ${String(request.ip)}`,
      );
      throw new ForbiddenException({
        message: 'CSRF token missing',
        code: 'CSRF_TOKEN_MISSING',
        statusCode: 403,
      });
    }

    // Tokens must match (Double Submit Cookie pattern)
    if (cookieToken !== headerToken) {
      this.logger.warn(
        `CSRF token mismatch for ${method} ${request.url} from ${String(request.ip)}`,
      );
      throw new ForbiddenException({
        message: 'CSRF token invalid',
        code: 'CSRF_TOKEN_INVALID',
        statusCode: 403,
      });
    }

    this.logger.debug(`CSRF validation passed for ${method} ${request.url}`);
    return true;
  }

  /**
   * Ensures CSRF cookie is set on response
   * Generates new token if not present
   * Returns the current token (existing or newly generated)
   */
  private ensureCsrfCookie(request: Request, response: Response): string {
    // Check for existing token in signedCookies
    const existingToken = request.signedCookies[this.csrfCookieName] as
      | string
      | undefined;

    if (existingToken !== undefined && existingToken !== '') {
      // Attach existing token to request for controller access
      Object.assign(request, { csrfToken: existingToken });
      return existingToken;
    }

    // Generate new token
    const newToken = this.generateToken();

    // Set signed cookie with secure options
    response.cookie(this.csrfCookieName, newToken, {
      httpOnly: false, // Must be accessible to JavaScript for reading
      signed: true, // Sign cookie with COOKIE_SECRET to prevent tampering
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      sameSite: 'none', // Allow cross-site cookies (required for datastic.org -> railway.app)
      partitioned: true, // Required for Chrome's Privacy Sandbox (future-proofing)
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      path: '/',
    });

    // Attach new token to request for controller access
    Object.assign(request, { csrfToken: newToken });

    this.logger.debug(
      `Generated new signed CSRF token for ${String(request.ip)}`,
    );
    return newToken;
  }
}

/**
 * Decorator to skip CSRF protection for specific routes
 * Use for: webhooks, public APIs, or routes with alternative protection
 *
 * Example:
 * @SkipCsrf()
 * @Post('/webhook/payment')
 * async handleWebhook() {}
 */
export const SkipCsrf = (): MethodDecorator => {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    Reflect.defineMetadata(
      'skipCsrf',
      true,
      descriptor.value as (...args: unknown[]) => unknown,
    );
    return descriptor;
  };
};
