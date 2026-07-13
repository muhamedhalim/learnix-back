import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AdminInitializationService } from './admin-init/admin-initialization.service';
import type { AdminInitResult } from './admin-init/admin-initialization.service';
import { AppService } from './app.service';
import { InitAdminGuard } from './auth/guards/init-admin.guard';
import { SkipCsrf } from './common/guards/csrf.guard';

@ApiTags('System')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly adminInitializationService: AdminInitializationService,
  ) {}

  @ApiOperation({
    summary: 'API root endpoint',
    description: 'Returns a welcome message for the Educational Platform API',
  })
  public getHello(): string {
    return this.appService.getHello();
  }

  @ApiResponse({
    status: 200,
    description: 'Health check successful',
    schema: {
      example: {
        status: 'ok',
        timestamp: '2025-10-17T12:00:00.000Z',
        uptime: 3600,
        database: 'connected',
        version: '1.0.0',
      },
    },
  })
  public getHealth(): {
    status: string;
    timestamp: string;
    uptime: number;
    environment: string;
    version: string;
  } {
    return this.appService.getHealth();
  }

  @ApiResponse({
    status: 200,
    description: 'List of available roles',
    schema: {
      example: {
        roles: ['admin', 'call_center', 'teacher', 'student'],
        descriptions: {
          admin: 'Platform administrator with full access',
          call_center: 'Call center staff for student support',
          teacher: 'Teacher who creates lessons and exams',
          student: 'Student who purchases and accesses content',
        },
      },
    },
  })
  public getRoles(): {
    roles: string[];
    descriptions: Record<string, string>;
  } {
    return this.appService.getRoles();
  }

  @ApiResponse({ status: 204, description: 'No content' })
  public getFavicon(): void {
    // No content
  }

  @Post('init-admin')
  @SkipCsrf()
  @UseGuards(InitAdminGuard)
  @ApiOperation({
    summary: 'Manually (re-)run admin initialization',
    description:
      'Runs the exact same AdminInitializationService.initialize() used automatically at every ' +
      'boot. This endpoint is self-disabling — it can only be called when no admin exists yet and ' +
      'requires a secret token — since it is a manual trigger for the same idempotent operation, ' +
      'not a separate code path.',
  })
  @ApiHeader({
    name: 'X-Init-Secret',
    description: 'Secret token required for admin initialization (INIT_SECRET)',
    required: true,
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: 201,
    description: 'Admin initialization outcome',
    schema: {
      example: { outcome: 'created', adminEmail: 'admin@example.com' },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Admin already exists - endpoint is disabled',
  })
  public async initAdmin(): Promise<AdminInitResult> {
    return await this.adminInitializationService.initialize();
  }
}
