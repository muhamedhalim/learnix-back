import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { resolveAppEnvLabel } from './config/app-env';
import { UserRole } from './users/entities/user-role.enum';

@Injectable()
export class AppService {
  private readonly startTime: number;

  constructor(private readonly configService: ConfigService) {
    this.startTime = Date.now();
  }

  public getHello(): string {
    return 'Educational Platform API';
  }

  public getHealth(): {
    status: string;
    timestamp: string;
    uptime: number;
    environment: string;
    version: string;
  } {
    const now = Date.now();
    const uptimeMs = now - this.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: uptimeSeconds,
      // APP_ENV, not NODE_ENV: this is a deployment-identity label, and staging
      // deliberately runs NODE_ENV=production. See docs/NODE_ENV_AUDIT.md #5.
      environment: resolveAppEnvLabel(this.configService.get.bind(this.configService)),
      version: '1.0.0',
    };
  }

  /**
   * Get available user roles (for documentation/API reference)
   */
  public getRoles(): {
    roles: string[];
    descriptions: Record<string, string>;
  } {
    return {
      roles: Object.values(UserRole),
      descriptions: {
        [UserRole.ADMIN]: 'Platform administrator with full access',
        [UserRole.CALL_CENTER]: 'Call center staff for student support',
        [UserRole.TEACHER]: 'Teacher who creates lessons and exams',
        [UserRole.STUDENT]: 'Student who purchases and accesses content',
      },
    };
  }
}
