import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestPerformanceContext {
  requestId: number;
  queryCount: number;
  dbDurationMs: number;
}

export const requestPerformanceStorage = new AsyncLocalStorage<RequestPerformanceContext>();

let nextRequestId = 0;

export function createRequestPerformanceContext(): RequestPerformanceContext {
  nextRequestId = (nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
  return {
    requestId: nextRequestId,
    queryCount: 0,
    dbDurationMs: 0,
  };
}

export function recordQueryForCurrentRequest(durationMs: number): void {
  const context = requestPerformanceStorage.getStore();
  if (!context) return;

  context.queryCount++;
  context.dbDurationMs += durationMs;
}
