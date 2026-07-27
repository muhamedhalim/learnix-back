import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource, type QueryRunner } from 'typeorm';

import { performanceMetrics } from '../../observability/performance-metrics.registry';
import type { HealthIndicator } from '../health-indicator.interface';
import { errorCode, sanitiseMessage } from '../health-sanitizer.util';
import { withHealthTimeout } from '../health-timeout.util';
import type { HealthComponentResult } from '../health.types';
import { componentResult, statusForLatency } from './indicator-result.util';

interface DatabaseStats {
  database_name: string;
  database_size_bytes: string;
  active_connections: string;
  idle_connections: string;
  max_connections: string;
  long_running_queries: string;
  committed_transactions: string;
  rolled_back_transactions: string;
}

interface PgPoolLike {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

@Injectable()
export class DatabaseHealthIndicator implements HealthIndicator {
  public readonly id = 'postgresql';

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  public async check(): Promise<HealthComponentResult> {
    const startedAt = Date.now();
    let runner: QueryRunner | null = null;
    try {
      runner = this.dataSource.createQueryRunner();
      await withHealthTimeout(this.id, runner.connect(), 4_000);
      const stats = (await withHealthTimeout(
        this.id,
        runner.query(`
          SELECT
            current_database() AS database_name,
            pg_database_size(current_database())::text AS database_size_bytes,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active')::text AS active_connections,
            (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle')::text AS idle_connections,
            current_setting('max_connections') AS max_connections,
            (SELECT count(*) FROM pg_stat_activity
              WHERE datname = current_database()
                AND state <> 'idle'
                AND pid <> pg_backend_pid()
                AND query_start < now() - interval '30 seconds')::text AS long_running_queries,
            xact_commit::text AS committed_transactions,
            xact_rollback::text AS rolled_back_transactions
          FROM pg_stat_database
          WHERE datname = current_database()
        `),
        5_000,
      )) as unknown as DatabaseStats[];
      const row = stats[0];
      if (!row) throw new Error('Database statistics were unavailable');

      const readWrite = await this.safeReadWriteTest(runner);
      const latencyMs = Date.now() - startedAt;
      const active = Number(row.active_connections);
      const max = Number(row.max_connections);
      const pool = this.getPool();
      const poolUsagePercent = pool.totalCount && max > 0 ? (pool.totalCount / max) * 100 : 0;
      let status = statusForLatency(latencyMs, 150, 750);
      if (!readWrite || active / Math.max(max, 1) >= 0.9 || (pool.waitingCount ?? 0) > 0) {
        status = 'degraded';
      } else if (active / Math.max(max, 1) >= 0.75 || Number(row.long_running_queries) > 0) {
        status = 'warning';
      }

      const metrics = performanceMetrics.snapshot();
      let pendingMigrations: boolean | null = null;
      try {
        pendingMigrations = await withHealthTimeout(
          this.id,
          this.dataSource.showMigrations(),
          3_000,
        );
      } catch {
        pendingMigrations = null;
      }

      return {
        ...componentResult({
          id: this.id,
          name: 'PostgreSQL',
          category: 'database',
          status,
          startedAt,
          message:
            status === 'healthy'
              ? 'Database connectivity, statistics, and temporary read/write test passed.'
              : 'Database latency, connection pressure, or transaction health needs attention.',
          metadata: {
            connected: true,
            databaseName: row.database_name,
            databaseSizeBytes: Number(row.database_size_bytes),
            activeConnections: active,
            idleConnections: Number(row.idle_connections),
            maxConnections: max,
            connectionUsagePercent: Math.round((active / Math.max(max, 1)) * 10_000) / 100,
            poolTotal: pool.totalCount ?? null,
            poolIdle: pool.idleCount ?? null,
            poolWaiting: pool.waitingCount ?? null,
            poolUsagePercent: Math.round(poolUsagePercent * 100) / 100,
            longRunningQueries: Number(row.long_running_queries),
            failedQueryCount: metrics.failedQueries,
            averageQueryLatencyMs: Math.round(metrics.averageQueryLatencyMs * 100) / 100,
            committedTransactions: Number(row.committed_transactions),
            rolledBackTransactions: Number(row.rolled_back_transactions),
            readTest: true,
            writeTest: readWrite,
            pendingMigrations,
            migrationStatus:
              pendingMigrations === null
                ? 'unavailable'
                : pendingMigrations
                  ? 'pending'
                  : 'current',
          },
          warnings: [
            ...(pendingMigrations === true ? ['Pending migrations detected.'] : []),
            ...(pendingMigrations === null ? ['Runtime migration metadata is unavailable.'] : []),
            ...(Number(row.long_running_queries) > 0
              ? ['Long-running database queries were detected.']
              : []),
          ],
          recommendation:
            status === 'healthy'
              ? null
              : 'Review connection pool saturation, long-running queries, and pending migrations.',
          critical: true,
        }),
        latencyMs,
      };
    } catch (error) {
      return componentResult({
        id: this.id,
        name: 'PostgreSQL',
        category: 'database',
        status: 'down',
        startedAt,
        message: sanitiseMessage(error),
        metadata: { connected: false, readTest: false, writeTest: false },
        errorCode: errorCode(error, 'DATABASE_UNAVAILABLE'),
        recommendation:
          'Verify the database service, network policy, credentials, SSL mode, and connection limits.',
        critical: true,
      });
    } finally {
      await runner?.release().catch(() => undefined);
    }
  }

  private async safeReadWriteTest(runner: QueryRunner): Promise<boolean> {
    await runner.startTransaction();
    try {
      await runner.query('CREATE TEMP TABLE learnix_health_probe(value integer) ON COMMIT DROP');
      await runner.query('INSERT INTO learnix_health_probe(value) VALUES (1)');
      const result = (await runner.query(
        'SELECT value FROM learnix_health_probe LIMIT 1',
      )) as unknown as Array<{ value: number }>;
      await runner.rollbackTransaction();
      return Number(result[0]?.value) === 1;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    }
  }

  private getPool(): PgPoolLike {
    const driver = this.dataSource.driver as unknown as {
      master?: PgPoolLike;
    };
    return driver.master ?? {};
  }
}
