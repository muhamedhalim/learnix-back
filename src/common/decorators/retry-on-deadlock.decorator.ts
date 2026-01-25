/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import { Logger } from '@nestjs/common';

/**
 * Configuration options for retry-on-deadlock decorator.
 */
export interface RetryOnDeadlockOptions {
  /**
   * Maximum number of retry attempts (default: 3)
   */
  maxRetries?: number;

  /**
   * Base delay in milliseconds before first retry (default: 100ms)
   * Subsequent retries use exponential backoff: baseDelay * 2^attempt
   */
  baseDelay?: number;

  /**
   * Optional logger instance for logging retry attempts
   * If not provided, a new logger with context 'RetryOnDeadlock' will be created
   */
  logger?: Logger;
}

/**
 * Decorator that automatically retries a method when a database deadlock is detected.
 *
 * @param options - Retry configuration options
 * @returns Method decorator
 *
 * @remarks
 * **Purpose:**
 * Handles transient deadlock errors that can occur when using pessimistic locking.
 * PostgreSQL can detect circular waits and abort one transaction with a deadlock error.
 * This decorator catches those errors and retries with exponential backoff.
 *
 * **Deadlock Detection:**
 * - PostgreSQL error code: '40P01' (serialization_failure - deadlock detected)
 * - TypeORM wraps this as QueryFailedError with driverError.code
 *
 * **Retry Strategy:**
 * - Exponential backoff: 100ms, 200ms, 400ms, 800ms...
 * - Jitter added to prevent thundering herd: ±20% randomization
 * - Max retries configurable (default: 3 attempts)
 * - Non-deadlock errors are not retried (fail fast)
 *
 * **Performance Considerations:**
 * - Total max delay with 3 retries: ~1.4 seconds worst case
 * - Only retries on deadlock (40P01), not on lock timeout or other errors
 * - Logs each retry attempt for observability
 *
 * **When to Use:**
 * - Methods that acquire multiple locks (higher deadlock potential)
 * - Payment processing flows with concurrent coupon/subscription checks
 * - Any transactional method using pessimistic locking
 *
 * **When NOT to Use:**
 * - Read-only methods (no deadlock risk)
 * - Methods with side effects that aren't idempotent
 * - Methods that should fail fast without retry
 *
 * @example
 * ```typescript
 * class PaymentService {
 *   @RetryOnDeadlock({ maxRetries: 5, baseDelay: 200 })
 *   async processPaymentWithCoupon(userId: number, couponCode: string) {
 *     // This method acquires locks on both User and Coupon tables
 *     // If deadlock occurs, it will retry up to 5 times
 *   }
 * }
 * ```
 */
export function RetryOnDeadlock(options: RetryOnDeadlockOptions = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 100;
  const logger = options.logger ?? new Logger('RetryOnDeadlock');

  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: any[]) {
      let lastError: any;

      for(let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await originalMethod.apply(this, args);
        } catch (error: any) {
          lastError = error;

          // Check if this is a deadlock error
          const isDeadlock = isDeadlockError(error);

          if(!isDeadlock || attempt === maxRetries) {
            // Not a deadlock or no more retries left - throw original error
            throw error;
          }

          // Calculate delay with exponential backoff and jitter
          const exponentialDelay = baseDelay * Math.pow(2, attempt);
          const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5); // ±10% jitter
          const delayMs = Math.floor(exponentialDelay + jitter);

          logger.warn(
            `Deadlock detected in ${String(target.constructor.name)}.${propertyKey}() - ` +
              `Attempt ${String(attempt + 1)}/${String(maxRetries + 1)} failed. ` +
              `Retrying in ${String(delayMs)}ms... ` +
              `Error: ${String(error.message)}`,
          );

          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // Should never reach here, but throw last error as fallback
      throw lastError;
    };

    return descriptor;
  };
}

/**
 * Checks if an error is a PostgreSQL deadlock error.
 *
 * @param error - Error to check
 * @returns True if error is a deadlock (PostgreSQL error code 40P01)
 *
 * @remarks
 * **PostgreSQL Error Codes:**
 * - 40P01: deadlock_detected (serialization failure due to deadlock)
 * - 40001: serialization_failure (general serialization failure, not always deadlock)
 *
 * **TypeORM Error Structure:**
 * - QueryFailedError wraps driver errors
 * - PostgreSQL errors have structure: { code: '40P01', ... }
 * - We check both error.code and error.driverError?.code for compatibility
 *
 * **False Positives Prevention:**
 * - Only treats 40P01 as deadlock (not 40001 or other errors)
 * - This ensures we don't retry non-deadlock serialization failures
 * - Non-deadlock errors should fail fast for debugging
 */
function isDeadlockError(error: any): boolean {
  if(!error) {return false;}

  // Check for PostgreSQL deadlock error code in various error structures
  const errorCode = error.code ?? error.driverError?.code;

  // PostgreSQL deadlock error code
  const POSTGRES_DEADLOCK_ERROR_CODE = '40P01';

  return errorCode === POSTGRES_DEADLOCK_ERROR_CODE;
}
