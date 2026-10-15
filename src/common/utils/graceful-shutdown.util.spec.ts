import { EventEmitter } from 'node:events';
import {
  installGracefulShutdown,
  isDraining,
  resetDrainingForTests,
  type ShutdownProcess,
} from './graceful-shutdown.util';

function fakeProcess(): ShutdownProcess & { emitter: EventEmitter; exit: jest.Mock } {
  const emitter = new EventEmitter();
  return {
    emitter,
    exit: jest.fn(),
    once: (signal, listener) => emitter.once(signal, listener),
  };
}

describe('installGracefulShutdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetDrainingForTests();
  });
  afterEach(() => jest.useRealTimers());

  it('marks the process as draining at once, waits the delay, then closes and exits 0', async () => {
    const proc = fakeProcess();
    const close = jest.fn().mockResolvedValue(undefined);
    installGracefulShutdown({ close }, { env: { SHUTDOWN_DELAY_MS: '10000' }, proc });

    proc.emitter.emit('SIGTERM');
    expect(isDraining()).toBe(true);
    expect(close).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(9_999);
    expect(close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('closes immediately when no delay is configured', async () => {
    const proc = fakeProcess();
    const close = jest.fn().mockResolvedValue(undefined);
    installGracefulShutdown({ close }, { env: {}, proc });

    proc.emitter.emit('SIGINT');
    await jest.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('runs once even if a second signal arrives', async () => {
    const proc = fakeProcess();
    const close = jest.fn().mockResolvedValue(undefined);
    installGracefulShutdown({ close }, { env: {}, proc });

    proc.emitter.emit('SIGTERM');
    proc.emitter.emit('SIGINT');
    await jest.advanceTimersByTimeAsync(0);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when closing fails', async () => {
    const proc = fakeProcess();
    installGracefulShutdown(
      { close: jest.fn().mockRejectedValue(new Error('boom')) },
      { env: {}, proc },
    );

    proc.emitter.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);

    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 instead of waiting for the SIGKILL when closing hangs', async () => {
    const proc = fakeProcess();
    installGracefulShutdown(
      { close: () => new Promise<void>(() => undefined) },
      { env: { SHUTDOWN_TIMEOUT_MS: '5000' }, proc },
    );

    proc.emitter.emit('SIGTERM');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});
