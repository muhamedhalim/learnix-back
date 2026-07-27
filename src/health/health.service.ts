import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { withHealthTimeout } from './health-timeout.util';

/**
 * Small public probe facade. Detailed health logic lives in the orchestrator
 * and component indicators; this class keeps the public liveness contract
 * deliberately minimal.
 */
@Injectable()
export class HealthService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public getPublicLiveness(): { status: 'healthy'; timestamp: string } {
    return { status: 'healthy', timestamp: new Date().toISOString() };
  }

  public async getReadiness(): Promise<{
    status: 'ready' | 'not_ready';
    timestamp: string;
  }> {
    let status: 'ready' | 'not_ready' = 'not_ready';

    try {
      await withHealthTimeout('readiness.database', this.dataSource.query('SELECT 1'), 2_000);
      status = 'ready';
    } catch {
      // Public probes deliberately return no infrastructure or failure details.
    }

    return {
      status,
      timestamp: new Date().toISOString(),
    };
  }
}
