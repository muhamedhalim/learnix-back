import { Controller, Get, HttpStatus, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Basic health check',
    description:
      'Returns basic health status of the application. Use this for monitoring tools and load balancers.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Application is healthy',
    schema: {
      example: {
        status: 'healthy',
        timestamp: '2025-01-19T12:00:00.000Z',
        uptime: 3600,
        version: '1.0.0',
        environment: 'production',
      },
    },
  })
  getHealth() {
    return this.healthService.getBasicHealth();
  }

  @Get('db')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Database health check (Admin only)',
    description:
      'Tests database connection and response time. Returns detailed database status. Requires admin authentication.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Database connection is healthy',
    schema: {
      example: {
        status: 'healthy',
        timestamp: '2025-01-19T12:00:00.000Z',
        uptime: 3600,
        database: {
          connected: true,
          type: 'postgres',
          responseTime: 15,
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Database connection failed',
    schema: {
      example: {
        status: 'unhealthy',
        timestamp: '2025-01-19T12:00:00.000Z',
        uptime: 3600,
        database: {
          connected: false,
          type: 'postgres',
          responseTime: 5000,
          error: 'Connection refused',
        },
      },
    },
  })
  async getDatabaseHealth() {
    const result = await this.healthService.getDatabaseHealth();
    return result;
  }

  @Get('storage')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Storage health check (Admin only)',
    description:
      'Checks Railway volume disk usage and available space. Alerts if storage is running low. Requires admin authentication.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Storage is healthy',
    schema: {
      example: {
        status: 'healthy',
        timestamp: '2025-01-19T12:00:00.000Z',
        uptime: 3600,
        storage: {
          path: '/app/uploads',
          exists: true,
          totalSpace: 10.0,
          freeSpace: 7.5,
          usedSpace: 2.5,
          usedPercentage: 25.0,
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Storage is unhealthy (>90% full or not accessible)',
    schema: {
      example: {
        status: 'unhealthy',
        timestamp: '2025-01-19T12:00:00.000Z',
        uptime: 3600,
        storage: {
          path: '/app/uploads',
          exists: true,
          totalSpace: 10.0,
          freeSpace: 0.5,
          usedSpace: 9.5,
          usedPercentage: 95.0,
        },
      },
    },
  })
  async getStorageHealth() {
    const result = await this.healthService.getStorageHealth();
    return result;
  }

  @Get('all')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Comprehensive health check (Admin only)',
    description:
      'Returns complete health status including basic, database, and storage checks.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'All systems are healthy',
  })
  async getComprehensiveHealth() {
    return this.healthService.getComprehensiveHealth();
  }
}
