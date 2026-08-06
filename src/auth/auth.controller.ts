import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import type { Request, Response } from 'express';

import { THROTTLE } from '../common/constants';
import { LOGIN_THROTTLE } from '../common/throttle/login-throttle';
import { getCrossSiteCookieOptions } from '../common/utils/cookie-security.util';
import { biBody, resolveRequestLocale } from '../i18n/error-translator.util';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_COOKIE_PATH,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from './auth-cookie.constants';
import { AuthService } from './auth.service';
import { accessTokenTtlMilliseconds, refreshTokenTtlMilliseconds } from './auth-token.config';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

interface TokenResponse {
  status: string;
  accessToken: string;
  refreshToken: string;
  role: string;
  userId: string;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Both authentication credentials are signed, HttpOnly, host-only cookies.
   * Production is always `SameSite=None; Secure` for the cross-site SPA/API
   * topology; development is Lax/non-Secure for localhost. The access cookie is
   * available to API routes and the refresh cookie only to auth routes.
   */
  private authCookieOptions(
    request: Request,
    path: string,
  ): {
    httpOnly: true;
    secure: boolean;
    sameSite: 'none' | 'lax';
    signed: true;
    partitioned: boolean;
    path: string;
  } {
    return {
      httpOnly: true,
      signed: true,
      ...getCrossSiteCookieOptions(request),
      path,
    };
  }

  private setAuthCookies(
    request: Request,
    response: Response,
    accessToken: string,
    refreshToken: string,
  ): void {
    response.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...this.authCookieOptions(request, ACCESS_TOKEN_COOKIE_PATH),
      maxAge: accessTokenTtlMilliseconds(process.env['JWT_EXPIRATION']),
    });
    response.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...this.authCookieOptions(request, REFRESH_TOKEN_COOKIE_PATH),
      maxAge: refreshTokenTtlMilliseconds(process.env['JWT_REFRESH_EXPIRATION']),
    });
  }

  private clearAuthCookies(request: Request, response: Response): void {
    response.clearCookie(
      ACCESS_TOKEN_COOKIE,
      this.authCookieOptions(request, ACCESS_TOKEN_COOKIE_PATH),
    );
    response.clearCookie(
      REFRESH_TOKEN_COOKIE,
      this.authCookieOptions(request, REFRESH_TOKEN_COOKIE_PATH),
    );
  }

  private issueSessionCookies(result: unknown, request: Request, response: Response): unknown {
    if (
      typeof result === 'object' &&
      result !== null &&
      'accessToken' in result &&
      typeof (result as TokenResponse).accessToken === 'string' &&
      'refreshToken' in result &&
      typeof (result as TokenResponse).refreshToken === 'string'
    ) {
      const tokenResult = result as TokenResponse;
      const { accessToken, refreshToken, ...body } = tokenResult;
      this.setAuthCookies(request, response, accessToken, refreshToken);
      return body;
    }

    return result;
  }

  @Post('register')
  // 202, not 201: the endpoint deliberately does not say whether a resource was
  // created. See AuthService.register for the full anti-enumeration contract.
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: THROTTLE.AUTH })
  @ApiOperation({
    summary: 'Request a student or teacher account',
    description:
      'Always answers with the same 202 acknowledgement — for a brand-new request, ' +
      'for an email/phone/parent phone that is already registered, for a still-pending ' +
      'request, and for one that loses a race to a simultaneous signup. The status, ' +
      'body, and body shape are identical in every case, so the endpoint cannot be used ' +
      'to discover whether an account exists. Malformed payloads still fail with 400.',
  })
  @ApiResponse({
    status: 202,
    description: 'Registration request acknowledged (reveals nothing about existing accounts)',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Registration request received. Pending approval' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Malformed registration payload' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async register(
    @Body() registerDto: RegisterDto,
    @Req() request: Request,
  ): Promise<{ message: string; message_ar: string }> {
    return await this.authService.register(registerDto, resolveRequestLocale(request));
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  // Resolves to THROTTLE.AUTH (5 per 5 min) on production with no override
  // path; only non-production deployments may raise it. See login-throttle.ts.
  @Throttle({ default: LOGIN_THROTTLE })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const deviceInfo = request.headers['user-agent'] ?? null;
    const ipAddress =
      (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0] ??
      request.ip ??
      null;

    const result = await this.authService.login(loginDto, deviceInfo, ipAddress);
    return this.issueSessionCookies(result, request, response);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // Tighten from the 300/min global backstop to limit refresh-token brute-force
  // / abuse. Uses the 5/min DEFAULT tier (not the stricter 5-per-5-min AUTH
  // tier) because refresh legitimately fires on every access-token expiry and
  // can burst across tabs/devices — 5/min still cuts the attack surface ~60x.
  @Throttle({ default: THROTTLE.DEFAULT })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const refreshToken =
      request.signedCookies?.[REFRESH_TOKEN_COOKIE] ?? request.cookies?.[REFRESH_TOKEN_COOKIE];
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      this.clearAuthCookies(request, response);
      throw new UnauthorizedException(
        biBody('Refresh token cookie is missing', 'كوكيز رمز التحديث غير موجود'),
      );
    }

    try {
      const result = await this.authService.refresh(refreshToken);
      return this.issueSessionCookies(result, request, response);
    } catch (error) {
      // Malformed, expired, reused, and revoked refresh credentials all fail
      // closed and remove both browser credentials.
      this.clearAuthCookies(request, response);
      throw error;
    }
  }

  @Post('forgot-password')
  @Throttle({ default: THROTTLE.AUTH })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a password reset',
    description:
      'Sends a single-use password reset link to the account email. Always returns a generic success message to prevent account enumeration.',
  })
  @ApiResponse({ status: 200, description: 'Generic acknowledgement returned' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async forgotPassword(
    @Body() forgotPasswordDto: ForgotPasswordDto,
  ): Promise<{ message: string; resetToken?: string }> {
    return await this.authService.forgotPassword(forgotPasswordDto.email);
  }

  @Post('reset-password')
  @Throttle({ default: THROTTLE.AUTH })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset a password using a reset token',
    description:
      'Validates the single-use reset token and sets a new password. Revokes all active sessions on success.',
  })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async resetPassword(
    @Body() resetPasswordDto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    return await this.authService.resetPassword(
      resetPasswordDto.token,
      resetPasswordDto.newPassword,
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  public async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ message: string }> {
    const { userId, sessionId } = request.user as { userId: string; sessionId: string };
    await this.authService.logout(userId, sessionId);
    this.clearAuthCookies(request, response);
    return biBody('Logged out successfully', 'تم تسجيل الخروج بنجاح');
  }

  @Get('csrf-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get CSRF token',
    description:
      'Returns CSRF token for frontend. The token is automatically set in XSRF-TOKEN cookie and should be sent in X-CSRF-Token header for all state-changing requests (POST/PUT/DELETE).',
  })
  @ApiResponse({
    status: 200,
    description: 'CSRF token returned (also set in cookie)',
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string', example: 'a1b2c3d4e5f6...' },
        message: { type: 'string', example: 'CSRF token generated' },
      },
    },
  })
  public getCsrfToken(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): {
    token: string | undefined;
    message: string;
  } {
    // A cached bootstrap response could return a token body without applying
    // the matching Set-Cookie header, resulting in a legitimate 403 on login.
    // CSRF token responses are per-browser-session and must never be cached.
    response.setHeader('Cache-Control', 'no-store, private');

    // Token is attached to request by CsrfGuard (handles both existing and new tokens)
    // This ensures the token is available even on the first request when cookie hasn't been set yet
    const token = (request as Request & { csrfToken?: string }).csrfToken;

    return {
      token,
      message:
        'CSRF token generated. Send this token in X-CSRF-Token header for state-changing requests.',
    };
  }
}
