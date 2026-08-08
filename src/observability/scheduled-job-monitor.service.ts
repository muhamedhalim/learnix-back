import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { captureHandledException } from './sentry';

/** Emitted after `alertAfterConsecutiveFailures` failed runs in a row. */
export const SCHEDULED_JOB_REPEATED_FAILURE_EVENT = 'scheduled_job.repeated_failure';

export interface ScheduledJobRepeatedFailurePayload {
  jobName: string;
  consecutiveFailures: number;
  error: string;
  errorCategory: string;
  lastFailedAt: string;
}

export interface ScheduledJobOptions {
  /** Consecutive failures before an operational alert is raised. Default 3. */
  alertAfterConsecutiveFailures?: number;
}

interface JobState {
  consecutiveFailures: number;
  lastStartedAt: string | null;
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  lastDurationMs: number | null;
  lastErrorCategory: string | null;
  runs: number;
  failures: number;
}

const DEFAULT_ALERT_AFTER = 3;

/**
 * Execution visibility for the business-critical `@Cron` jobs.
 *
 * A NestJS `@Cron` method that stops firing — a wedged process, an unhandled
 * rejection inside the timer, a scheduler that never started on the elected
 * replica — produces no signal at all: no log, no metric, no failed job row.
 * Payment expiry, gateway reconciliation and webhook recovery all run this way,
 * so this wrapper gives each one a start/finish log line, a duration, a
 * consecutive-failure count, Sentry capture on unexpected errors, and an
 * operational alert once failures repeat.
 *
 * Deliberately narrow (Phase 1): this is applied to the payment-critical jobs
 * only, and it does NOT replace `SchedulerHealthIndicator`. Comprehensive
 * per-cron heartbeat/staleness detection for all eleven jobs is later-phase
 * work.
 *
 * Alerting goes out as an event rather than a direct service call: this lives
 * in `ObservabilityModule`, the alert delivery path lives in `HealthModule`,
 * and `HealthModule` already imports `PaymentsModule`. Emitting reuses the
 * existing global EventEmitter and keeps that dependency edge one-directional.
 */
@Injectable()
export class ScheduledJobMonitorService {
  private readonly logger = new Logger(ScheduledJobMonitorService.name);
  private readonly states = new Map<string, JobState>();

  public constructor(private readonly events: EventEmitter2) {}

  /**
   * Runs `task` with execution monitoring. The task's own return value is
   * passed through unchanged, and its errors still propagate — this observes,
   * it does not swallow. A caller that must not throw keeps its own try/catch.
   */
  public async run<T>(
    jobName: string,
    task: () => Promise<T>,
    options: ScheduledJobOptions = {},
  ): Promise<T> {
    const state = this.stateFor(jobName);
    const startedAt = Date.now();
    state.lastStartedAt = new Date(startedAt).toISOString();
    state.runs++;

    this.logger.log(
      JSON.stringify({
        event: 'scheduled_job_started',
        jobName,
        startedAt: state.lastStartedAt,
        run: state.runs,
      }),
    );

    try {
      const result = await task();
      const durationMs = Date.now() - startedAt;
      state.consecutiveFailures = 0;
      state.lastSucceededAt = new Date().toISOString();
      state.lastDurationMs = durationMs;
      state.lastErrorCategory = null;
      this.logger.log(
        JSON.stringify({
          event: 'scheduled_job_completed',
          jobName,
          status: 'succeeded',
          durationMs,
          completedAt: state.lastSucceededAt,
          ...(typeof result === 'number' ? { processedCount: result } : {}),
        }),
      );
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const category = errorCategory(error);
      state.consecutiveFailures++;
      state.failures++;
      state.lastFailedAt = new Date().toISOString();
      state.lastDurationMs = durationMs;
      state.lastErrorCategory = category;

      this.logger.error(
        JSON.stringify({
          event: 'scheduled_job_completed',
          jobName,
          status: 'failed',
          durationMs,
          failedAt: state.lastFailedAt,
          consecutiveFailures: state.consecutiveFailures,
          errorCategory: category,
          error: error instanceof Error ? error.message : String(error),
        }),
        error instanceof Error ? error.stack : undefined,
      );

      // A cron failure has no HTTP request behind it, so the exception filter
      // never sees it. Reported with a synthetic route so it groups by job.
      captureHandledException(error, {
        requestId: `cron:${jobName}:${state.lastFailedAt}`,
        method: 'CRON',
        route: `cron:${jobName}`,
        status: 500,
      });

      const threshold = options.alertAfterConsecutiveFailures ?? DEFAULT_ALERT_AFTER;
      if (state.consecutiveFailures >= threshold) {
        const payload: ScheduledJobRepeatedFailurePayload = {
          jobName,
          consecutiveFailures: state.consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
          errorCategory: category,
          lastFailedAt: state.lastFailedAt,
        };
        // Fire-and-forget: alerting must never affect the job's own outcome.
        this.events.emit(SCHEDULED_JOB_REPEATED_FAILURE_EVENT, payload);
      }

      throw error;
    }
  }

  /** Read-only view for diagnostics and future health-indicator wiring. */
  public snapshot(): Record<string, JobState> {
    return Object.fromEntries([...this.states].map(([name, state]) => [name, { ...state }]));
  }

  private stateFor(jobName: string): JobState {
    let state = this.states.get(jobName);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        lastStartedAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastDurationMs: null,
        lastErrorCategory: null,
        runs: 0,
        failures: 0,
      };
      this.states.set(jobName, state);
    }
    return state;
  }
}

function errorCategory(error: unknown): string {
  const candidate = error as { code?: unknown; name?: unknown };
  return String(candidate?.code ?? candidate?.name ?? 'UNKNOWN')
    .replaceAll(/[^A-Za-z0-9_-]/gu, '_')
    .slice(0, 80);
}
