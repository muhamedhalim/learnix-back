import { Controller, Get, Param, ParseUUIDPipe, Query, Redirect } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { THROTTLE } from '../../common/constants';
import { PaymentOperationsService } from '../services/payment-operations.service';

/** Gateway-reported outcomes that may be echoed to the UI as a display hint. */
const DISPLAY_STATUSES: ReadonlySet<string> = new Set(['success', 'pending', 'failed']);

/**
 * Browser return from the EasyKash hosted page (the per-payment `redirectUrl`).
 *
 * The query string is attacker-controllable, so nothing in it decides payment
 * state. It only forwards a sanitised voucher number and a display hint; the
 * frontend always reads the real status from the backend, which in turn only
 * changes on the HMAC-verified callback or the authenticated inquiry API.
 */
@ApiTags('Payments - Hosted return')
@Controller('payments/easykash/return')
export class PaymentsReturnController {
  constructor(
    private readonly operations: PaymentOperationsService,
    private readonly config: ConfigService,
  ) {}

  @Get(':paymentId')
  @Throttle({ default: THROTTLE.SEARCH })
  @Redirect(undefined, 302)
  @ApiOperation({ summary: 'Customer return from the hosted payment page (display only)' })
  public async handleReturn(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Query('status') status?: string,
    @Query('voucher') voucher?: string,
  ): Promise<{ url: string }> {
    const frontend = (this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/u, '');
    const target = await this.operations.resolveHostedReturn(paymentId);

    const params = new URLSearchParams();
    let path = '/student/payments';
    if (target.kind === 'order' && target.id !== null) {
      path = '/student/payment-return';
      params.set('orderId', target.id);
    } else if (target.kind === 'marketplace' && target.id !== null) {
      path = '/student/marketplace-orders/payment-return';
      params.set('orderId', target.id);
    }
    const hint = typeof status === 'string' ? status.toLowerCase() : '';
    if (DISPLAY_STATUSES.has(hint)) params.set('gateway_status', hint);
    if (typeof voucher === 'string' && /^\d{1,20}$/u.test(voucher)) params.set('voucher', voucher);

    const query = params.toString();
    return { url: `${frontend}${path}${query === '' ? '' : `?${query}`}` };
  }
}
