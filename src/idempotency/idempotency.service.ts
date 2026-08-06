import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createClient, RedisClientType } from 'redis';

import { namespacedPrefix } from '../common/utils/redis-namespace.util';

/**
 * Result of an idempotency check
 */
export interface IdempotencyCheckResult<T = unknown> {
  /**
   * Whether this request has already been processed
   */
  isProcessed: boolean;

  /**
   * Cached result from previous processing (if isProcessed === true)
   */
  cachedResult?: T;
}

/**
 * Service for managing idempotent request processing with Redis-backed storage.
 *
 * @remarks
 * **Purpose:**
 * Prevents duplicate processing of webhook callbacks and payment requests.
 * Critical for:
 * - Webhook retry handling (payment gateway may retry on network errors)
 * - Duplicate form submission prevention
 * - Race condition protection at application level
 *
 * **How Idempotency Works:**
 * 1. Client provides idempotency_key in request
 * 2. Server checks if key exists in Redis
 * 3. If exists -> return cached response (request already processed)
 * 4. If not exists -> process request, cache result in Redis
 * 5. Key expires after TTL (24 hours default)
 *
 * **Redis Key Structure:**
 * ```
 * idempotency:webhook:{payment_id}:{kashier_order_id} = {result JSON}
 * idempotency:payment:{user_id}:{idempotency_key} = {result JSON}
 * TTL: 86400 seconds (24 hours)
 * ```
 *
 * **Use Cases:**
 * - Webhook callbacks from payment gateways (most critical)
 * - Payment initiation requests (prevent double-charge)
 * - Subscription activation (prevent duplicate subscriptions)
 * - Coupon application (prevent double-discount)
 *
 * @example
 * ```typescript
 * // Check if webhook already processed
 * const check = await idempotencyService.checkWebhook(paymentId, kashierOrderId);
 * if (check.isProcessed) {
 *   return check.cachedResult; // Return cached response, skip processing
 * }
 *
 * // Process webhook
 * const result = await processWebhook();
 *
 * // Store result for future duplicate requests
 * await idempotencyService.storeWebhookResult(paymentId, kashierOrderId, result);
 * ```
 */
@Injectable()
export class IdempotencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdempotencyService.name);

  // TTL for idempotency keys: 24 hours in seconds
  private readonly idempotencyTtl = 86_400;

  private redisClient?: RedisClientType;

  /** Empty on a resolved-production environment — see `redis-namespace.util.ts`. */
  private keyPrefix = '';

  constructor(private readonly configService: ConfigService) {}

  /**
   * Initializes Redis connection on module startup.
   */
  public async onModuleInit(): Promise<void> {
    const redisUrl = this.configService.get<string>('REDIS_URL');

    if (redisUrl === undefined || redisUrl === '') {
      this.logger.error('REDIS_URL not configured - idempotency disabled');
      return;
    }

    this.keyPrefix = namespacedPrefix((key) => this.configService.get<string>(key));

    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';

    const client: RedisClientType = createClient({
      url: redisUrl,
      // Development: node-redis's default reconnectStrategy retries forever,
      // which is what turned an unreachable REDIS_URL (e.g. still pointing at
      // a production-only host) into unbounded "Redis connection error" log
      // spam — the client kept retrying in the background even after the
      // failed connect() below was caught. Production keeps the default
      // strategy unchanged so a transient outage still recovers on its own.
      ...(isProduction ? {} : { socket: { reconnectStrategy: false as const } }),
    });

    client.on('error', (err: Error) => {
      this.logger.error(`Redis connection error: ${err.message}`);
    });

    try {
      await client.connect();
      // Only wired up on success — every `isReady` check below already
      // treats an unset client as "unavailable", and this guarantees the
      // failure branch below is the only place that needs to tear the
      // client down.
      this.redisClient = client;
      this.logger.log('Redis connected for idempotency service');
    } catch (error) {
      this.logger.error(
        `Failed to connect to Redis: ${(error as Error).message}. Idempotency disabled.`,
      );
      // Tear down explicitly so no background reconnect attempt keeps
      // running against a host that was already unreachable once. With
      // reconnectStrategy: false (development), node-redis has usually
      // already self-destroyed the socket by the time connect() rejects —
      // disconnect() on an already-closed client throws synchronously
      // (ClientClosedError), so this must be a try/catch, not `.catch()`.
      if (client.isOpen) {
        try {
          await client.disconnect();
        } catch {
          // Already closing/closed — nothing further to do.
        }
      }
    }
  }

  /**
   * Disconnects Redis on module shutdown.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.redisClient) {
      await this.redisClient.quit();
      this.logger.log('Redis disconnected');
    }
  }

  /**
   * Checks if a webhook has already been processed.
   *
   * @param paymentId - Payment ID from database
   * @param externalOrderId - Order ID from payment gateway (e.g., Kashier order ID)
   * @returns Idempotency check result with cached response if already processed
   *
   * @remarks
   * **Key Format:** `idempotency:webhook:{paymentId}:{externalOrderId}`
   *
   * **Use Case:**
   * Payment gateways may retry webhooks due to:
   * - Network timeouts
   * - 5xx errors from our server
   * - Webhook acknowledgment not received
   *
   * Without idempotency, retries would cause:
   * - Duplicate course enrollments
   * - Duplicate subscription activations
   * - Duplicate coupon usage records
   */
  public async checkWebhook(
    paymentId: string,
    externalOrderId: string,
  ): Promise<IdempotencyCheckResult> {
    if (this.redisClient?.isReady !== true) {
      this.logger.warn('Redis not ready - skipping idempotency check');
      return { isProcessed: false };
    }

    const key = this.buildWebhookKey(paymentId, externalOrderId);

    try {
      const cachedData = await this.redisClient.get(key);

      if (cachedData !== null) {
        this.logger.log(
          `Webhook idempotency hit - Payment: ${paymentId}, Order: ${externalOrderId}`,
        );
        return {
          isProcessed: true,
          cachedResult: JSON.parse(cachedData),
        };
      }

      return { isProcessed: false };
    } catch (error) {
      this.logger.error(`Redis error checking webhook idempotency: ${(error as Error).message}`);
      // On Redis error, allow processing to proceed (fail open)
      return { isProcessed: false };
    }
  }

  /**
   * Stores the result of webhook processing for future deduplication.
   *
   * @param paymentId - Payment ID from database
   * @param externalOrderId - Order ID from payment gateway
   * @param result - Result to cache (will be JSON-serialized)
   *
   * @remarks
   * **TTL:** 24 hours (86400 seconds)
   *
   * **Why 24 hours?**
   * - Payment gateways typically retry for max 24 hours
   * - Longer TTL wastes Redis memory
   * - Shorter TTL risks missing late retries
   *
   * **Error Handling:**
   * If Redis fails, logs error but doesn't throw (graceful degradation).
   * System will work without idempotency protection if Redis is down.
   */
  public async storeWebhookResult(
    paymentId: string,
    externalOrderId: string,
    result: unknown,
  ): Promise<void> {
    if (this.redisClient?.isReady !== true) {
      this.logger.warn('Redis not ready - skipping result storage');
      return;
    }

    const key = this.buildWebhookKey(paymentId, externalOrderId);

    try {
      await this.redisClient.setEx(key, this.idempotencyTtl, JSON.stringify(result));

      this.logger.log(`Stored webhook result - Payment: ${paymentId}, Order: ${externalOrderId}`);
    } catch (error) {
      this.logger.error(`Redis error storing webhook result: ${(error as Error).message}`);
      // Don't throw - webhook processing succeeded, just cache failed
    }
  }

  /**
   * Checks if a payment request has already been processed.
   *
   * @param userId - User ID making the payment request
   * @param idempotencyKey - Client-provided idempotency key (UUID recommended)
   * @returns Idempotency check result with cached response if already processed
   *
   * @remarks
   * **Key Format:** `idempotency:payment:{userId}:{idempotencyKey}`
   *
   * **Use Case:**
   * Prevents duplicate payment initiation from:
   * - Double-clicks on "Pay Now" button
   * - Browser back/forward navigation
   * - Network retry by frontend
   *
   * **Client Responsibility:**
   * Frontend should generate UUID and include in payment request.
   * Same key should be used for retries of the same logical operation.
   */
  public async checkPaymentRequest(
    userId: string,
    idempotencyKey: string,
  ): Promise<IdempotencyCheckResult> {
    if (this.redisClient?.isReady !== true) {
      this.logger.warn('Redis not ready - skipping idempotency check');
      return { isProcessed: false };
    }

    const key = this.buildPaymentKey(userId, idempotencyKey);

    try {
      const cachedData = await this.redisClient.get(key);

      if (cachedData !== null) {
        this.logger.log(`Payment idempotency hit - User: ${userId}, Key: ${idempotencyKey}`);
        return {
          isProcessed: true,
          cachedResult: JSON.parse(cachedData),
        };
      }

      return { isProcessed: false };
    } catch (error) {
      this.logger.error(`Redis error checking payment idempotency: ${(error as Error).message}`);
      return { isProcessed: false };
    }
  }

  /**
   * Stores the result of payment initiation for future deduplication.
   *
   * @param userId - User ID
   * @param idempotencyKey - Client-provided idempotency key
   * @param result - Result to cache (payment URL, payment ID, etc.)
   *
   * @remarks
   * Should be called AFTER payment initiation succeeds.
   * If payment fails, don't store result (allow retry with same key).
   */
  public async storePaymentResult(
    userId: string,
    idempotencyKey: string,
    result: unknown,
  ): Promise<void> {
    if (this.redisClient?.isReady !== true) {
      this.logger.warn('Redis not ready - skipping result storage');
      return;
    }

    const key = this.buildPaymentKey(userId, idempotencyKey);

    try {
      await this.redisClient.setEx(key, this.idempotencyTtl, JSON.stringify(result));

      this.logger.log(`Stored payment result - User: ${userId}, Key: ${idempotencyKey}`);
    } catch (error) {
      this.logger.error(`Redis error storing payment result: ${(error as Error).message}`);
    }
  }

  /**
   * Manually clears an idempotency key (admin/debugging use).
   *
   * @param key - Full Redis key to clear
   *
   * @remarks
   * **Use Cases:**
   * - Debugging failed webhooks
   * - Forcing reprocessing of stuck payment
   * - Admin intervention for payment issues
   *
   * **Warning:** Use carefully - clearing key allows duplicate processing.
   */
  public async clearKey(key: string): Promise<void> {
    if (this.redisClient?.isReady !== true) {
      throw new Error('Redis not ready');
    }

    try {
      await this.redisClient.del(key);
      this.logger.log(`Cleared idempotency key: ${key}`);
    } catch (error) {
      this.logger.error(`Redis error clearing key: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Builds Redis key for webhook idempotency.
   *
   * @param paymentId - Internal payment ID
   * @param externalOrderId - External order ID from gateway
   * @returns Redis key string
   */
  private buildWebhookKey(paymentId: string, externalOrderId: string): string {
    return `${this.keyPrefix}idempotency:webhook:${paymentId}:${externalOrderId}`;
  }

  /**
   * Builds Redis key for payment request idempotency.
   *
   * @param userId - User ID
   * @param idempotencyKey - Client-provided key
   * @returns Redis key string
   */
  private buildPaymentKey(userId: string, idempotencyKey: string): string {
    return `${this.keyPrefix}idempotency:payment:${userId}:${idempotencyKey}`;
  }
}
