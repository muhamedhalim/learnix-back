const captureHandledExceptionMock = jest.fn();

jest.mock('./sentry', () => ({
  captureHandledException: (...args: unknown[]) => captureHandledExceptionMock(...args),
}));

import { Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

import {
  SCHEDULED_JOB_REPEATED_FAILURE_EVENT,
  ScheduledJobMonitorService,
} from './scheduled-job-monitor.service';

function buildMonitor(): { monitor: ScheduledJobMonitorService; emit: jest.Mock } {
  const emit = jest.fn();
  const monitor = new ScheduledJobMonitorService({ emit } as unknown as EventEmitter2);
  return { monitor, emit };
}

describe('ScheduledJobMonitorService', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    captureHandledExceptionMock.mockClear();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function loggedLines(spy: jest.SpyInstance): string {
    return spy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  describe('successful runs', () => {
    it('logs a start and a completion with a duration', async () => {
      const { monitor } = buildMonitor();

      await monitor.run('payments.webhook_recovery', async () => 7);

      const logged = loggedLines(logSpy);
      expect(logged).toContain('"event":"scheduled_job_started"');
      expect(logged).toContain('"event":"scheduled_job_completed"');
      expect(logged).toContain('"status":"succeeded"');
      expect(logged).toContain('"jobName":"payments.webhook_recovery"');
      expect(logged).toContain('"durationMs"');
    });

    it('records the processed count when the job returns one', async () => {
      const { monitor } = buildMonitor();
      await monitor.run('payments.webhook_recovery', async () => 42);
      expect(loggedLines(logSpy)).toContain('"processedCount":42');
    });

    it('passes the job result through unchanged', async () => {
      const { monitor } = buildMonitor();
      await expect(monitor.run('job', async () => 'value')).resolves.toBe('value');
    });

    it('resets the consecutive-failure count after a recovery', async () => {
      const { monitor, emit } = buildMonitor();
      const failing = async () => {
        throw new Error('nope');
      };

      await expect(monitor.run('job', failing)).rejects.toThrow();
      await expect(monitor.run('job', failing)).rejects.toThrow();
      await monitor.run('job', async () => undefined);
      await expect(monitor.run('job', failing)).rejects.toThrow();

      // Three failures total but never three in a row → no alert.
      expect(emit).not.toHaveBeenCalled();
      expect(monitor.snapshot()['job']?.consecutiveFailures).toBe(1);
    });
  });

  describe('failed runs', () => {
    it('logs the failure with a category and re-throws (observe, do not swallow)', async () => {
      const { monitor } = buildMonitor();
      const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });

      await expect(
        monitor.run('payments.gateway_reconciliation', async () => {
          throw error;
        }),
      ).rejects.toThrow('timeout');

      const logged = loggedLines(errorSpy);
      expect(logged).toContain('"status":"failed"');
      expect(logged).toContain('"errorCategory":"ETIMEDOUT"');
    });

    it('reports the failure to Sentry with a synthetic cron route', async () => {
      const { monitor } = buildMonitor();
      const error = new Error('boom');

      await expect(
        monitor.run('payments.finance_maintenance', async () => {
          throw error;
        }),
      ).rejects.toThrow();

      expect(captureHandledExceptionMock).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          route: 'cron:payments.finance_maintenance',
          method: 'CRON',
          status: 500,
        }),
      );
    });

    it('emits a repeated-failure event only after three consecutive failures', async () => {
      const { monitor, emit } = buildMonitor();
      const failing = async () => {
        throw new Error('still broken');
      };

      await expect(monitor.run('job', failing)).rejects.toThrow();
      expect(emit).not.toHaveBeenCalled();

      await expect(monitor.run('job', failing)).rejects.toThrow();
      expect(emit).not.toHaveBeenCalled();

      await expect(monitor.run('job', failing)).rejects.toThrow();
      expect(emit).toHaveBeenCalledTimes(1);
      expect(emit).toHaveBeenCalledWith(
        SCHEDULED_JOB_REPEATED_FAILURE_EVENT,
        expect.objectContaining({ jobName: 'job', consecutiveFailures: 3 }),
      );
    });

    it('honours a custom alert threshold', async () => {
      const { monitor, emit } = buildMonitor();
      const failing = async () => {
        throw new Error('broken');
      };

      await expect(
        monitor.run('job', failing, { alertAfterConsecutiveFailures: 1 }),
      ).rejects.toThrow();

      expect(emit).toHaveBeenCalledTimes(1);
    });

    it('tracks each job independently', async () => {
      const { monitor, emit } = buildMonitor();
      const failing = async () => {
        throw new Error('broken');
      };

      await expect(monitor.run('job-a', failing)).rejects.toThrow();
      await expect(monitor.run('job-b', failing)).rejects.toThrow();
      await expect(monitor.run('job-a', failing)).rejects.toThrow();

      expect(emit).not.toHaveBeenCalled();
      expect(monitor.snapshot()['job-a']?.consecutiveFailures).toBe(2);
      expect(monitor.snapshot()['job-b']?.consecutiveFailures).toBe(1);
    });
  });
});
