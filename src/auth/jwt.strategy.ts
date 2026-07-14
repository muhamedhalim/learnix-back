import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';

import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';

import { AuthService } from './auth.service';
import { ACCESS_TOKEN_COOKIE } from './auth-cookie.constants';

function accessTokenFromSignedCookie(request: Request): string | null {
  const token = request.signedCookies?.[ACCESS_TOKEN_COOKIE];
  return typeof token === 'string' && token !== '' ? token : null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    const jwtSecret = configService.get<string>('JWT_SECRET');

    if (jwtSecret === undefined || jwtSecret === '') {
      throw new Error('JWT_SECRET environment variable is not configured');
    }

    if (jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long');
    }

    if (jwtSecret === 'your-secret-key' || jwtSecret === 'change-me') {
      throw new Error('JWT_SECRET cannot be a default/example value');
    }

    super({
      jwtFromRequest: ExtractJwt.fromExtractors([accessTokenFromSignedCookie]),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  public async validate(payload: { sub: string; email: string; sid: string }): Promise<unknown> {
    const user = await this.authService.validateUser(payload);
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }
}
