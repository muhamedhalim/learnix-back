import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { AppService } from './app.service';
import { InitAdminGuard } from './auth/guards/init-admin.guard';

@ApiTags('System')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'API root endpoint',
    description: 'Returns a welcome message for the Educational Platform API',
  })
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @ApiOperation({
    summary: 'Health check endpoint',
    description:
      'Returns application health status, uptime, and database connection status. No authentication required.',
  })
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
  async getHealth() {
    return this.appService.getHealth();
  }

  @Get('roles')
  @ApiOperation({
    summary: 'Get available user roles',
    description: 'Returns list of all user roles available in the system',
  })
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
  getRoles() {
    return this.appService.getRoles();
  }

  @Post('init-admin')
  @UseGuards(InitAdminGuard)
  @ApiOperation({
    summary: 'Initialize first admin user',
    description:
      'Creates the first admin user. This endpoint is self-disabling - it can only be called when no admin exists and requires a secret token.',
  })
  @ApiHeader({
    name: 'X-Init-Secret',
    description: 'Secret token required for admin initialization (INIT_SECRET)',
    required: true,
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: 201,
    description: 'Admin user successfully created',
    schema: {
      example: {
        success: true,
        message: 'Admin initialization completed',
        adminEmail: 'admin@example.com',
        results: ['Admin user created: admin@example.com'],
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Missing required environment variables (ADMIN_INIT_EMAIL, ADMIN_INIT_PASSWORD)',
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid X-Init-Secret header',
  })
  @ApiResponse({
    status: 403,
    description: 'Admin already exists - endpoint is disabled',
  })
  async initAdmin() {
    return this.appService.initAdmin();
  }
}
