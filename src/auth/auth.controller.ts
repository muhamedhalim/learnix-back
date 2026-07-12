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
import { getCrossSiteCookieOptions } from '../common/utils/cookie-security.util';
import { durationToMilliseconds as parseDurationToMs } from '../common/utils/duration.util';
import { biBody, resolveRequestLocale } from '../i18n/error-translator.util';
import { AuthService } from './auth.service';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

const REFRESH_TOKEN_COOKIE = 'refresh_token';

interface TokenResponse {
  status: string;
  token: string;
  refreshToken?: string;
  role: string;
  userId: string;
}

const DEFAULT_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Refresh-cookie maxAge in ms, defaulting to 7 days for invalid/unset input. */
function durationToMilliseconds(duration: string): number {
  return parseDurationToMs(duration) ?? DEFAULT_REFRESH_TTL_MS;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Cookie attributes for the HttpOnly refresh token. In production the SPA and
   * API are served from different sites (e.g. learnix.school ⟷ *.railway.app),
   * so the cookie must be `SameSite=None; Secure` (and Partitioned/CHIPS) to be
   * sent on the cross-site refresh request. Locally (plain HTTP) it stays
   * `Lax`/non-Secure — derived from the actual request via
   * `getCrossSiteCookieOptions`, not a bare `NODE_ENV` check, so a `Secure`
   * cookie is never requested over a connection where the browser would just
   * silently drop it. CSRF for the refresh endpoint is still enforced by the
   * double-submit CsrfGuard, so this does not open a CSRF hole.
   */
  private refreshCookieOptions(request: Request): {
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
      path: '/api/v1/auth',
    };
  }

  private setRefreshTokenCookie(request: Request, response: Response, refreshToken: string): void {
    response.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...this.refreshCookieOptions(request),
      maxAge: durationToMilliseconds(process.env['JWT_REFRESH_EXPIRATION'] ?? '7d'),
    });
  }

  private clearRefreshTokenCookie(request: Request, response: Response): void {
    response.clearCookie(REFRESH_TOKEN_COOKIE, this.refreshCookieOptions(request));
  }

  private stripRefreshToken(result: unknown, request: Request, response: Response): unknown {
    if (
      typeof result === 'object' &&
      result !== null &&
      'refreshToken' in result &&
      typeof (result as TokenResponse).refreshToken === 'string'
    ) {
      const tokenResult = result as TokenResponse & { refreshToken: string };
      const { refreshToken, ...body } = tokenResult;
      this.setRefreshTokenCookie(request, response, refreshToken);
      return body;
    }

    return result;
  }

  @Post('register')
  @Throttle({ default: THROTTLE.AUTH })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async register(
    @Body() registerDto: RegisterDto,
    @Req() request: Request,
  ): Promise<unknown> {
    return await this.authService.register(registerDto, resolveRequestLocale(request));
  }

  @Post('login')
  @Throttle({ default: THROTTLE.AUTH })
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
    return this.stripRefreshToken(result, request, response);
  }

  @Post('refresh')
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
      throw new UnauthorizedException(
        biBody('Refresh token cookie is missing', 'كوكيز رمز التحديث غير موجود'),
      );
    }

    const result = await this.authService.refresh(refreshToken);
    return this.stripRefreshToken(result, request, response);
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
  @UseGuards(JwtAuthGuard)
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  public async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ message: string }> {
    const { userId } = request.user as { userId: string };
    await this.authService.logout(userId);
    this.clearRefreshTokenCookie(request, response);
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
  public getCsrfToken(@Req() request: Request): {
    token: string | undefined;
    message: string;
  } {
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
