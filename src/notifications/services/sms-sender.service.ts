import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import twilio from 'twilio';

import { maskPhone } from '../../common/utils/mask.util';
import { evaluatePhoneRecipient } from '../../common/utils/staging-messaging-guard.util';

export interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class SmsSenderService {
  private readonly logger = new Logger(SmsSenderService.name);
  private readonly twilioClient: twilio.Twilio | null = null;
  private readonly fromNumber: string;

  constructor(private readonly configService: ConfigService) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') ?? '';

    if (
      accountSid !== undefined &&
      accountSid !== '' &&
      authToken !== undefined &&
      authToken !== ''
    ) {
      this.twilioClient = twilio(accountSid, authToken);
      this.logger.log('Twilio client initialized successfully');
    } else {
      this.logger.warn('Twilio credentials not configured - SMS sending disabled');
    }
  }

  /**
   * Format Egyptian phone number to international format
   * Accepts: 01012345678, +201012345678, 201012345678
   * Returns: +201012345678
   */
  private formatPhoneNumber(phone: string): string {
    // Remove any spaces, dashes, or parentheses
    const cleaned = phone.replaceAll(/[\s\-()]/g, '');

    // Already in international format
    if (cleaned.startsWith('+20')) {
      return cleaned;
    }

    // Has country code but no plus
    if (cleaned.startsWith('20') && cleaned.length === 12) {
      return `+${cleaned}`;
    }

    // Local Egyptian number (starts with 0)
    if (cleaned.startsWith('0') && cleaned.length === 11) {
      return `+2${cleaned}`;
    }

    // Assume local number without leading zero
    if (cleaned.length === 10) {
      return `+20${cleaned}`;
    }

    // Return as-is with plus if not already there
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }

  /**
   * Send SMS to a single recipient
   */
  public async sendSms(to: string, message: string): Promise<SmsResult> {
    if (!this.twilioClient) {
      this.logger.warn('SMS not sent - Twilio client not configured');
      return {
        success: false,
        error: 'SMS service not configured',
      };
    }

    const formattedPhone = this.formatPhoneNumber(to);

    // Staging-only enforcement (inert on production) — every Twilio call in
    // this app funnels through this one method, so this single check covers
    // guardian notifications, admin bulk sends, and anything added later.
    // Sandboxed sends are reported as SUCCESS (no real messageId) rather than
    // failure: callers should observe "delivered" without an actual SMS
    // reaching anyone, not a false failure that trips retries/fallback.
    const decision = evaluatePhoneRecipient(
      (key) => this.configService.get<string>(key),
      formattedPhone,
    );
    if (decision.blocked) {
      this.logger.log(`SMS sandboxed, not sent (${decision.reason ?? 'staging'}).`);
      return { success: true };
    }

    try {
      const result = await this.twilioClient.messages.create({
        body: message,
        from: this.fromNumber,
        to: formattedPhone,
      });

      // Masked: a guardian's full E.164 number is personal data and must never
      // reach the production log stream. The Twilio SID is the correlation
      // handle for support, and `maskPhone` keeps the last 3 digits, which is
      // enough to confirm "the right number" without disclosing it. Matches
      // what `WhatsAppMetaChannel` already does for the same event.
      this.logger.log(
        `SMS sent successfully to ${maskPhone(formattedPhone) ?? '***'}: ${result.sid}`,
      );

      return {
        success: true,
        messageId: result.sid,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Failed to send SMS to ${maskPhone(formattedPhone) ?? '***'}: ${errorMessage}`,
      );

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Send SMS to multiple recipients
   * Returns array of results in same order as recipients
   */
  public async sendBulkSms(
    recipients: Array<{ phone: string; message: string }>,
  ): Promise<SmsResult[]> {
    const results = await Promise.all(
      recipients.map(
        async ({ phone, message }) =>
          await this.sendSms(phone, message).catch((error: unknown) => ({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          })),
      ),
    );

    const successCount = results.filter((r) => r.success).length;
    this.logger.log(
      `Bulk SMS: ${successCount.toString()}/${recipients.length.toString()} sent successfully`,
    );

    return results;
  }

  /**
   * Check if SMS service is available
   */
  public isConfigured(): boolean {
    return this.twilioClient !== null;
  }
}
