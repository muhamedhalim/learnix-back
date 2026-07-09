import { Body, Controller, Logger, Post, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { performanceMetrics } from '../../observability/performance-metrics.registry';
import { IdempotencyService } from '../../idempotency/idempotency.service';
import { EasyKashWebhookDto } from '../dto/easykash-webhook.dto';
import { EasyKashService } from '../services/easykash.service';
import { PaymentsService } from '../services/payments.service';

interface WebhookResponse {
  status: 'success' | 'pending' | 'failed' | 'refunded' | 'error' | 'already_processed';
  message?: string;
  payment_id?: string;
  transaction_id?: string;
}

/*
 * EasyKash `status` values, from the official docs. The callback service fires
 * with "PAID"; the full set is enumerated by the Payment Inquiry API and mapped
 * defensively here so any future callback status is handled without guessing.
 */
const REFUNDED_STATUSES = ['REFUNDED', 'CANCELED'];
const SUCCESS_STATUSES = ['PAID', 'DELIVERED'];
const PENDING_STATUSES = ['NEW'];
// Anything else (e.g. FAILED, EXPIRED) → failed.

// EasyKash's callback does not include a currency field, and the platform only
// ever charges in EGP (see EasyKashService), so the amount/currency guard is
// fed EGP. Amounts are reported in major units → convert to piastres/cents.
const EXPECTED_CURRENCY = 'EGP';

@ApiTags('Payments - Webhook')
@Controller('payments/webhook')
// EasyKash calls this from its own servers; legitimacy is verified via HMAC, and
// rate-limiting it could silently drop payment confirmations.
@SkipThrottle()
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    private readonly easyKashService: EasyKashService,
    private readonly paymentsService: PaymentsService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  public async handleEasyKashWebhook(@Body() dto: EasyKashWebhookDto): Promise<WebhookResponse> {
    this.logger.log(`Received EasyKash callback: status=${dto.status}, ref=${dto.easykashRef}`);

    // Step 1: Verify HMAC signature (CRITICAL SECURITY)
    const isValidHmac = this.easyKashService.verifyHmac(dto, dto.signatureHash);
    if (!isValidHmac) {
      performanceMetrics.recordFailure('webhook');
      this.logger.warn(`HMAC verification failed for callback ${dto.easykashRef}`);
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    // `customerReference` is our payment.id, echoed back by EasyKash.
    const merchantOrderId = dto.customerReference;
    const transactionId = dto.easykashRef;

    if (merchantOrderId === '') {
      this.logger.warn('Callback missing customerReference');
      return { status: 'error', message: 'Missing customerReference' };
    }

    // Step 2: Check idempotency (prevent duplicate processing)
    const idempotencyCheck = await this.idempotencyService.checkWebhook(
      merchantOrderId,
      transactionId,
    );

    if (idempotencyCheck.isProcessed) {
      this.logger.log(
        `Callback already processed for payment ${merchantOrderId}, transaction ${transactionId}`,
      );
      return idempotencyCheck.cachedResult as WebhookResponse;
    }

    // Step 3: Find payment by merchant order ID
    const payment = await this.paymentsService.getPaymentByMerchantOrderId(merchantOrderId);

    if (!payment) {
      this.logger.warn(`Payment not found for customerReference: ${merchantOrderId}`);
      return { status: 'error', message: 'Payment not found' };
    }

    // Verified financial facts from the (HMAC-authenticated) callback, threaded
    // into the service so access is only granted for the exact expected charge.
    // EasyKash reports Amount in major units (EGP) → convert to cents to match
    // the existing amount-tamper guard.
    const verification = {
      amountCents: Math.round(Number(dto.Amount) * 100),
      currency: EXPECTED_CURRENCY,
      transactionId,
    };

    const status = dto.status.toUpperCase();

    // Step 4: Process based on transaction outcome
    let result: WebhookResponse;

    if (REFUNDED_STATUSES.includes(status)) {
      // A refunded/canceled transaction must NEVER grant (or keep) access.
      this.logger.log(`Payment ${merchantOrderId} refunded/canceled, revoking entitlement...`);
      await this.paymentsService.processRefundedPayment(payment.id, verification);
      result = {
        status: 'refunded',
        message: 'Payment refunded or canceled',
        payment_id: payment.id,
        transaction_id: transactionId,
      };
    } else if (SUCCESS_STATUSES.includes(status)) {
      // Payment successful (the documented callback case).
      this.logger.log(`Payment ${merchantOrderId} successful, granting access...`);

      try {
        await this.paymentsService.processSuccessfulPayment(payment.id, verification);
        result = {
          status: 'success',
          message: 'Payment completed, access granted',
          payment_id: payment.id,
          transaction_id: transactionId,
        };
      } catch (error) {
        // Includes amount/currency-mismatch rejections (fail-closed: no access).
        performanceMetrics.recordFailure('payment');
        this.logger.error(`Failed to process successful payment ${merchantOrderId}`, error);
        result = {
          status: 'error',
          message: 'Failed to grant access',
          payment_id: payment.id,
        };
      }
    } else if (PENDING_STATUSES.includes(status)) {
      this.logger.log(`Payment ${merchantOrderId} pending`);
      result = {
        status: 'pending',
        message: 'Payment pending verification',
        payment_id: payment.id,
        transaction_id: transactionId,
      };
    } else {
      // Payment failed (e.g. FAILED, EXPIRED).
      this.logger.log(`Payment ${merchantOrderId} failed: status=${dto.status}`);
      await this.paymentsService.processFailedPayment(payment.id, dto.status, verification);
      result = {
        status: 'failed',
        message: dto.status,
        payment_id: payment.id,
        transaction_id: transactionId,
      };
    }

    // Step 5: Store result for idempotency
    await this.idempotencyService.storeWebhookResult(payment.id, transactionId, result);

    return result;
  }

  @Post('callback')
  @ApiOperation({
    summary: 'Alternative EasyKash callback URL',
    description: 'Alternative endpoint for EasyKash callbacks. Same processing as /webhook.',
  })
  public async handleEasyKashCallback(@Body() dto: EasyKashWebhookDto): Promise<WebhookResponse> {
    return await this.handleEasyKashWebhook(dto);
  }
}
