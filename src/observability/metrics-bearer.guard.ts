import { timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Request } from 'express';

@Injectable()
export class MetricsBearerGuard implements CanActivate {
  public constructor(private readonly configService: ConfigService) {}

  public canActivate(context: ExecutionContext): boolean {
    const configuredToken = this.configService.get<string>('METRICS_BEARER_TOKEN');

    if (!configuredToken) {
      throw new ServiceUnavailableException(
        'Metrics endpoint is disabled until METRICS_BEARER_TOKEN is configured',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.headers.authorization;
    const suppliedToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : '';

    if (!this.tokensMatch(suppliedToken, configuredToken)) {
      throw new UnauthorizedException('Invalid metrics bearer token');
    }

    return true;
  }

  private tokensMatch(suppliedToken: string, configuredToken: string): boolean {
    const supplied = Buffer.from(suppliedToken);
    const configured = Buffer.from(configuredToken);

    return supplied.length === configured.length && timingSafeEqual(supplied, configured);
  }
}
