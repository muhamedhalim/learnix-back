import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import twilio from 'twilio';

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
    this.fromNumber =
      this.configService.get<string>('TWILIO_PHONE_NUMBER') ?? '';

    if (
      accountSid !== undefined &&
      accountSid !== '' &&
      authToken !== undefined &&
      authToken !== ''
    ) {
      this.twilioClient = twilio(accountSid, authToken);
      this.logger.log('Twilio client initialized successfully');
    } else {
      this.logger.warn(
        'Twilio credentials not configured - SMS sending disabled',
      );
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

    try {
      const result = await this.twilioClient.messages.create({
        body: message,
        from: this.fromNumber,
        to: formattedPhone,
      });

      this.logger.log(
        `SMS sent successfully to ${formattedPhone}: ${result.sid}`,
      );

      return {
        success: true,
        messageId: result.sid,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        `Failed to send SMS to ${formattedPhone}: ${errorMessage}`,
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
