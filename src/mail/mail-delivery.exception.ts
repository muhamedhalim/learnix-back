import { InternalServerErrorException } from '@nestjs/common';

/** A stable application-level error that never exposes a provider (SES) response. */
export class MailDeliveryException extends InternalServerErrorException {
  public constructor(message = 'Email delivery failed.') {
    super(message);
  }
}
