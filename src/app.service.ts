import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
      environment: this.configService.get<string>('NODE_ENV') ?? 'development',
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
