import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';

import { existsSync } from 'fs';
import { statfs } from 'fs/promises';
import { DataSource } from 'typeorm';

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version?: string;
  environment?: string;
}

export interface DatabaseHealthResult extends HealthCheckResult {
  database: {
    connected: boolean;
    type: string;
    responseTime: number;
    error?: string;
  };
}

export interface StorageHealthResult extends HealthCheckResult {
  storage: {
    path: string;
    exists: boolean;
    totalSpace: number;
    freeSpace: number;
    usedSpace: number;
    usedPercentage: number;
    error?: string;
  };
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly uploadDir: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {
    this.uploadDir =
      this.configService.get<string>('UPLOAD_DIR') ?? '/app/uploads';
  }

  /**
   * Basic health check - just confirms app is running
   */
  public getBasicHealth(): HealthCheckResult {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
      environment: this.configService.get<string>('NODE_ENV') ?? 'development',
    };
  }

  /**
   * Database health check - tests connection and response time
   */
  public async getDatabaseHealth(): Promise<DatabaseHealthResult> {
    const startTime = Date.now();
    let dbStatus: DatabaseHealthResult;

    try {
      // Test database connection by running a simple query
      await this.dataSource.query('SELECT 1');
      const responseTime = Date.now() - startTime;

      dbStatus = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: true,
          type: this.dataSource.options.type,
          responseTime,
        },
      };

      this.logger.log(
        `Database health check passed - Response time: ${String(responseTime)}ms`,
      );
    } catch (error) {
      const responseTime = Date.now() - startTime;

      dbStatus = {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          connected: false,
          type: this.dataSource.options.type,
          responseTime,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };

      this.logger.error('Database health check failed', error);
    }

    return dbStatus;
  }

  /**
   * Storage health check - checks Railway volume status
   */
  public async getStorageHealth(): Promise<StorageHealthResult> {
    try {
      const pathExists = existsSync(this.uploadDir);

      if (!pathExists) {
        this.logger.warn(`Upload directory does not exist: ${this.uploadDir}`);

        return {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          storage: {
            path: this.uploadDir,
            exists: false,
            totalSpace: 0,
            freeSpace: 0,
            usedSpace: 0,
            usedPercentage: 0,
            error: 'Upload directory does not exist',
          },
        };
      }

      // Get filesystem statistics
      const stats = await statfs(this.uploadDir);

      // Calculate space in bytes
      const totalSpace = stats.blocks * stats.bsize;
      const freeSpace = stats.bfree * stats.bsize;
      const usedSpace = totalSpace - freeSpace;
      const usedPercentage = (usedSpace / totalSpace) * 100;

      // Convert to GB for readability
      const toGB = (bytes: number): string =>
        (bytes / (1024 * 1024 * 1024)).toFixed(2);

      const storageStatus: StorageHealthResult = {
        status: usedPercentage > 90 ? 'unhealthy' : 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        storage: {
          path: this.uploadDir,
          exists: true,
          totalSpace: parseFloat(toGB(totalSpace)),
          freeSpace: parseFloat(toGB(freeSpace)),
          usedSpace: parseFloat(toGB(usedSpace)),
          usedPercentage: parseFloat(usedPercentage.toFixed(2)),
        },
      };

      if (usedPercentage > 90) {
        this.logger.warn(
          `Storage usage critical: ${usedPercentage.toFixed(2)}% used`,
        );
      } else if (usedPercentage > 80) {
        this.logger.warn(
          `Storage usage high: ${usedPercentage.toFixed(2)}% used`,
        );
      } else {
        this.logger.log(
          `Storage health check passed - ${usedPercentage.toFixed(2)}% used`,
        );
      }

      return storageStatus;
    } catch (error) {
      this.logger.error('Storage health check failed', error);

      return {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        storage: {
          path: this.uploadDir,
          exists: false,
          totalSpace: 0,
          freeSpace: 0,
          usedSpace: 0,
          usedPercentage: 0,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Comprehensive health check - combines all health checks
   */
  public async getComprehensiveHealth(): Promise<{
    overall: 'healthy' | 'unhealthy';
    basic: HealthCheckResult;
    database: DatabaseHealthResult;
    storage: StorageHealthResult;
  }> {
    const [basic, database, storage] = await Promise.all([
      this.getBasicHealth(),
      this.getDatabaseHealth(),
      this.getStorageHealth(),
    ]);

    const overall =
      basic.status === 'healthy' &&
      database.status === 'healthy' &&
      storage.status === 'healthy'
        ? 'healthy'
        : 'unhealthy';

    return {
      overall,
      basic,
      database,
      storage,
    };
  }
}
