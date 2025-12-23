import {
  Controller,
  Post,
  Body,
  Logger,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PaymobWebhookDto } from '../dto/paymob-webhook.dto';
import { PaymobService } from '../services/paymob.service';
import { PaymentsService } from '../services/payments.service';
import { IdempotencyService } from '../../idempotency/idempotency.service';

interface WebhookResponse {
  status: 'success' | 'pending' | 'failed' | 'error' | 'already_processed';
  message?: string;
  payment_id?: number;
  transaction_id?: number;
}

@ApiTags('Payments - Webhook')
@Controller('payments/webhook')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    private readonly paymobService: PaymobService,
    private readonly paymentsService: PaymentsService,
    private readonly idempotencyService: IdempotencyService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Paymob payment callback webhook',
    description:
      'Handles payment status updates from Paymob. HMAC signature verification is required.',
  })
  @ApiResponse({ status: 200, description: 'Webhook processed successfully' })
  @ApiResponse({ status: 401, description: 'Invalid HMAC signature' })
  async handlePaymobWebhook(
    @Body() dto: PaymobWebhookDto,
  ): Promise<WebhookResponse> {
    this.logger.log(
      `Received Paymob webhook: type=${dto.type}, transaction_id=${dto.obj?.id}`,
    );

    // Step 1: Verify HMAC signature (CRITICAL SECURITY)
    const isValidHmac = this.paymobService.verifyHmac(dto, dto.hmac);
    if (!isValidHmac) {
      this.logger.warn(
        `HMAC verification failed for transaction ${dto.obj?.id}`,
      );
      throw new UnauthorizedException('Invalid HMAC signature');
    }

    const merchantOrderId = dto.obj.order?.merchant_order_id;
    const transactionId = dto.obj.id;

    if (!merchantOrderId) {
      this.logger.warn('Webhook missing merchant_order_id');
      return { status: 'error', message: 'Missing merchant_order_id' };
    }

    // Step 2: Check idempotency (prevent duplicate processing)
    const idempotencyCheck = await this.idempotencyService.checkWebhook(
      parseInt(merchantOrderId, 10),
      transactionId.toString(),
    );

    if (idempotencyCheck.isProcessed) {
      this.logger.log(
        `Webhook already processed for payment ${merchantOrderId}, transaction ${transactionId}`,
      );
      return (
        (idempotencyCheck.cachedResult as WebhookResponse) || {
          status: 'already_processed',
        }
      );
    }

    // Step 3: Find payment by merchant order ID
    const payment =
      await this.paymentsService.getPaymentByMerchantOrderId(merchantOrderId);

    if (!payment) {
      this.logger.warn(
        `Payment not found for merchant_order_id: ${merchantOrderId}`,
      );
      return { status: 'error', message: 'Payment not found' };
    }

    // Step 4: Process based on transaction success
    let result: WebhookResponse;

    if (dto.obj.success && !dto.obj.pending) {
      // Payment successful
      this.logger.log(
        `Payment ${merchantOrderId} successful, granting access...`,
      );

      try {
        await this.paymentsService.processSuccessfulPayment(payment.id);
        result = {
          status: 'success',
          message: 'Payment completed, access granted',
          payment_id: payment.id,
          transaction_id: transactionId,
        };
      } catch (error) {
        this.logger.error(
          `Failed to process successful payment ${merchantOrderId}`,
          error,
        );
        result = {
          status: 'error',
          message: 'Failed to grant access',
          payment_id: payment.id,
        };
      }
    } else if (dto.obj.pending) {
      // Payment pending (3D Secure, etc.)
      this.logger.log(`Payment ${merchantOrderId} pending`);
      result = {
        status: 'pending',
        message: 'Payment pending verification',
        payment_id: payment.id,
        transaction_id: transactionId,
      };
    } else {
      // Payment failed
      const failureReason = dto.obj.data_message || 'Payment declined';
      this.logger.log(`Payment ${merchantOrderId} failed: ${failureReason}`);

      await this.paymentsService.processFailedPayment(
        payment.id,
        failureReason,
      );
      result = {
        status: 'failed',
        message: failureReason,
        payment_id: payment.id,
        transaction_id: transactionId,
      };
    }

    // Step 5: Store result for idempotency
    await this.idempotencyService.storeWebhookResult(
      payment.id,
      transactionId.toString(),
      result,
    );

    return result;
  }

  @Post('callback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Alternative Paymob callback URL',
    description:
      'Alternative endpoint for Paymob callbacks. Same processing as /webhook.',
  })
  async handlePaymobCallback(
    @Body() dto: PaymobWebhookDto,
  ): Promise<WebhookResponse> {
    return this.handlePaymobWebhook(dto);
  }
}
