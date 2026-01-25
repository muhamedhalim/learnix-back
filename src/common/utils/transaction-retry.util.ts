/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { Logger } from '@nestjs/common';

import { DataSource, EntityManager } from 'typeorm';

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
  errorCode?: string;
  errorMessage?: string;
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
  const isolationLevel = options.isolationLevel;

  let lastError: any;

  for(let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute transaction with optional isolation level
      if(isolationLevel) {
        return await dataSource.transaction(isolationLevel, transactionFn);
      } else {
        return await dataSource.transaction(transactionFn);
      }
    } catch (error: any) {
      lastError = error;

      // Check if this is a deadlock error
      const deadlockCheck = checkDeadlockError(error);

      if(!deadlockCheck.isDeadlock || attempt === maxRetries) {
        // Not a deadlock or no more retries left
        if(deadlockCheck.isDeadlock && attempt === maxRetries) {
          logger.error(
            `Transaction failed after ${String(maxRetries + 1)} attempts due to persistent deadlocks. ` +
              `Last error: ${String(error.message)}`,
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
 * Checks if an error is a PostgreSQL deadlock error with detailed information.
 *
 * @param error - Error to check
 * @returns Deadlock check result with error code and message
 *
 * @remarks
 * **Detection Strategy (in order of priority):**
 * 1. Check for exact deadlock error code '40P01'
 * 2. Check for serialization failure code '40001' (may indicate deadlock)
 * 3. Check error message for 'deadlock detected' string (fallback)
 *
 * **PostgreSQL Error Codes:**
 * - 40P01: deadlock_detected (definite deadlock)
 * - 40001: serialization_failure (may be deadlock or other serialization issue)
 *
 * **Why Multiple Checks:**
 * Different PostgreSQL versions and drivers may report deadlocks differently.
 * Message checking ensures we catch deadlocks even if error code is missing.
 *
 * **False Positives:**
 * May incorrectly identify some serialization failures as deadlocks, but this is
 * acceptable because:
 * - Retrying serialization failures is generally safe
 * - False positives are rare in practice
 * - Better to retry too much than too little for transient errors
 */
function checkDeadlockError(error: any): DeadlockCheckResult {
  if(!error) {
    return { isDeadlock: false };
  }

  // Extract error code from various possible error structures
  const errorCode = error.code ?? error.driverError?.code ?? error.errno;

  // Extract error message
  const errorMessage =
    error.message ?? error.driverError?.message ?? String(error);

  // PostgreSQL error codes for deadlocks and serialization failures
  const DEADLOCK_ERROR_CODE = '40P01'; // Definite deadlock
  const SERIALIZATION_FAILURE_CODE = '40001'; // May be deadlock

  // Check error code first (most reliable)
  if(errorCode === DEADLOCK_ERROR_CODE) {
    return {
      isDeadlock: true,
      errorCode: DEADLOCK_ERROR_CODE,
      errorMessage,
    };
  }

  if(errorCode === SERIALIZATION_FAILURE_CODE) {
    // 40001 may or may not be a deadlock, but safe to retry
    return {
      isDeadlock: true,
      errorCode: SERIALIZATION_FAILURE_CODE,
      errorMessage,
    };
  }

  // Fallback: Check error message for deadlock keywords
  if(
    errorMessage?.toLowerCase().includes('deadlock detected')
  ) {
    return {
      isDeadlock: true,
      errorCode: errorCode ?? 'unknown',
      errorMessage,
    };
  }

  return { isDeadlock: false, errorCode, errorMessage };
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

  let lastError: any;

  for(let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      const deadlockCheck = checkDeadlockError(error);

      if(!deadlockCheck.isDeadlock || attempt === maxRetries) {
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
