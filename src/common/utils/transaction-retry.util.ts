import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

/**
 * Configuration options for transaction retry utility.
 */
export interface TransactionRetryOptions {
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
   * If not provided, uses default logger with context 'TransactionRetry'
   */
  logger?: Logger;

  /**
   * Transaction isolation level (default: database default)
   * Options: 'READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'
   */
  isolationLevel?:
    | 'READ UNCOMMITTED'
    | 'READ COMMITTED'
    | 'REPEATABLE READ'
    | 'SERIALIZABLE';
}

/**
 * Result of a deadlock error check.
 */
interface DeadlockCheckResult {
  isDeadlock: boolean;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Utility for executing database transactions with automatic deadlock retry.
 *
 * @remarks
 * **Purpose:**
 * Provides programmatic transaction retry logic for scenarios where the
 * @RetryOnDeadlock decorator cannot be used:
 * - Inline transactions in service methods
 * - Complex multi-step transactions
 * - Transactions that need custom retry logic
 *
 * **Deadlock Detection:**
 * Detects PostgreSQL deadlock errors by checking:
 * - Error code '40P01' (serialization_failure - deadlock detected)
 * - Error code '40001' (serialization_failure - sometimes deadlock)
 * - Error message contains 'deadlock detected' (fallback check)
 *
 * **Retry Strategy:**
 * - Exponential backoff with jitter: 100ms, 200ms, 400ms...
 * - Jitter prevents thundering herd (±20% randomization)
 * - Only retries on detected deadlocks
 * - Non-deadlock errors fail immediately
 *
 * **Transaction Management:**
 * - Creates new transaction for each attempt
 * - Previous transaction is rolled back on deadlock
 * - Each retry gets a fresh EntityManager
 * - Maintains ACID properties across retries
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await retryTransaction(dataSource, async (manager) => {
 *   const user = await manager.findOne(User, { where: { id: 1 }, lock: { mode: 'pessimistic_write' } });
 *   const coupon = await manager.findOne(Coupon, { where: { code: 'SAVE10' }, lock: { mode: 'pessimistic_write' } });
 *   // ... perform operations
 *   return result;
 * });
 *
 * // With options
 * const result = await retryTransaction(
 *   dataSource,
 *   async (manager) => {
 *     // transaction logic
 *   },
 *   {
 *     maxRetries: 5,
 *     baseDelay: 200,
 *     isolationLevel: 'SERIALIZABLE'
 *   }
 * );
 * ```
 */
export async function retryTransaction<T>(
  dataSource: DataSource,
  transactionFn: (manager: EntityManager) => Promise<T>,
  options: TransactionRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 100;
  const logger = options.logger ?? new Logger('TransactionRetry');
  const { isolationLevel } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute transaction with optional isolation level
      if (isolationLevel !== undefined) {
        return await dataSource.transaction<T>(isolationLevel, transactionFn);
      }
      return await dataSource.transaction<T>(transactionFn);
    } catch (error: unknown) {
      lastError = error;

      // Check if this is a deadlock error
      const deadlockCheck = checkDeadlockError(error);

      if (!deadlockCheck.isDeadlock || attempt === maxRetries) {
        // Not a deadlock or no more retries left
        if (deadlockCheck.isDeadlock && attempt === maxRetries) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error(
            `Transaction failed after ${String(maxRetries + 1)} attempts due to persistent deadlocks. ` +
              `Last error: ${errorMessage}`,
          );
        }
        throw error;
      }
      // Calculate delay with exponential backoff and jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5); // ±10% jitter
      const delayMs = Math.floor(exponentialDelay + jitter);

      logger.warn(
        `Deadlock detected - Attempt ${String(attempt + 1)}/${String(maxRetries + 1)} failed. ` +
          `Retrying in ${String(delayMs)}ms... ` +
          `Error code: ${String(deadlockCheck.errorCode)}, ` +
          `Message: ${String(deadlockCheck.errorMessage)}`,
      );

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here, but throw last error as fallback
  throw lastError;
}

/**
 * Safely extracts an error message from an unknown error object.
 */
function extractErrorMessage(error: unknown): string {
  if (error === null || error === undefined) {
    return 'Unknown error';
  }

  const errorObj = error as Record<string, unknown>;
  const driverError = errorObj['driverError'] as
    | Record<string, unknown>
    | undefined;

  if (typeof errorObj['message'] === 'string') {
    return errorObj['message'];
  }

  if (typeof driverError?.['message'] === 'string') {
    return driverError['message'];
  }

  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Safely extracts a database error code from an unknown error object.
 */
function extractErrorCode(error: unknown): string | number | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }

  const errorObj = error as Record<string, unknown>;
  const driverError = errorObj['driverError'] as
    | Record<string, unknown>
    | undefined;

  return (errorObj['code'] ?? driverError?.['code'] ?? errorObj['errno']) as
    | string
    | number
    | undefined;
}

/**
 * Checks if an error is a PostgreSQL deadlock error with detailed information.
 *
 * @param error - Error to check
 * @returns Deadlock check result with error code and message
 */
function checkDeadlockError(error: unknown): DeadlockCheckResult {
  if (error === null || error === undefined) {
    return { isDeadlock: false };
  }

  const errorCode = extractErrorCode(error);
  const errorMessage = extractErrorMessage(error);

  const DEADLOCK_ERROR_CODE = '40P01';
  const SERIALIZATION_FAILURE_CODE = '40001';

  if (
    errorCode === DEADLOCK_ERROR_CODE ||
    errorCode === SERIALIZATION_FAILURE_CODE
  ) {
    return {
      isDeadlock: true,
      errorCode: typeof errorCode === 'string' ? errorCode : String(errorCode),
      errorMessage,
    };
  }

  if (errorMessage.toLowerCase().includes('deadlock detected')) {
    return {
      isDeadlock: true,
      errorCode: errorCode !== undefined ? String(errorCode) : 'unknown',
      errorMessage,
    };
  }

  return {
    isDeadlock: false,
    errorCode: errorCode !== undefined ? String(errorCode) : undefined,
    errorMessage,
  };
}

/**
 * Utility function for retrying any async operation (not just transactions).
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration options
 * @returns Result of the function
 *
 * @remarks
 * **Use Cases:**
 * - Retrying database queries outside transactions
 * - Retrying external API calls with transient failures
 * - Any operation that may experience temporary deadlocks
 *
 * **Difference from retryTransaction:**
 * - Does NOT create a database transaction
 * - Simply retries the provided function
 * - Useful for raw queries or non-transactional operations
 *
 * @example
 * ```typescript
 * const result = await retryOperation(
 *   async () => {
 *     return await someService.criticalOperation();
 *   },
 *   { maxRetries: 5, baseDelay: 200 }
 * );
 * ```
 */
export async function retryOperation<T>(
  fn: () => Promise<T>,
  options: Omit<TransactionRetryOptions, 'isolationLevel'> = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelay ?? 100;
  const logger = options.logger ?? new Logger('RetryOperation');

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      const deadlockCheck = checkDeadlockError(error);

      if (!deadlockCheck.isDeadlock || attempt === maxRetries) {
        throw error;
      }

      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = exponentialDelay * 0.2 * (Math.random() - 0.5);
      const delayMs = Math.floor(exponentialDelay + jitter);

      logger.warn(
        `Operation failed with deadlock - Attempt ${String(attempt + 1)}/${String(maxRetries + 1)}. ` +
          `Retrying in ${String(delayMs)}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
