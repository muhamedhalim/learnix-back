import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import type { Request } from 'express';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async register(@Body() registerDto: RegisterDto): Promise<unknown> {
    return await this.authService.register(registerDto);
  }

  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async login(@Body() loginDto: LoginDto): Promise<unknown> {
    return await this.authService.login(loginDto);
  }

  @ApiResponse({ status: 429, description: 'Too many requests' })
  public async refresh(
    @Body() refreshTokenDto: RefreshTokenDto,
  ): Promise<unknown> {
    return await this.authService.refresh(refreshTokenDto.refresh_token);
  }

  @ApiResponse({ status: 401, description: 'Unauthorized' })
  public async logout(@Req() request: Request): Promise<{ message: string }> {
    const { userId } = request.user as { userId: string };
    await this.authService.logout(userId);
    return { message: 'Logged out successfully' };
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
