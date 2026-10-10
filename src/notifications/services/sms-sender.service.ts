import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import twilio from 'twilio';

import { maskPhone } from '../../common/utils/mask.util';
import { evaluatePhoneRecipient } from '../../common/utils/staging-messaging-guard.util';

export type SmsProvider = 'aws' | 'twilio' | 'none';

/**
 * Which provider sends SMS. `SMS_PROVIDER=aws|twilio` is explicit; when unset the historic
 * behaviour is kept (Twilio if its credentials exist, otherwise SMS is disabled).
 */
export function resolveSmsProvider(get: (key: string) => string | undefined): SmsProvider {
  const explicit = get('SMS_PROVIDER')?.trim().toLowerCase();
  if (explicit === 'aws' || explicit === 'twilio') return explicit;
  if (explicit === 'none') return 'none';
  return (get('TWILIO_ACCOUNT_SID') ?? '') !== '' && (get('TWILIO_AUTH_TOKEN') ?? '') !== ''
    ? 'twilio'
    : 'none';
}

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
  private readonly provider: SmsProvider;
  private readonly awsClient: PinpointSMSVoiceV2Client | null = null;
  private readonly awsOrigination: string;
  private readonly awsConfigurationSet: string | undefined;
  private readonly awsProtectConfiguration: string | undefined;
  private readonly allowedPrefixes: string[];

  constructor(private readonly configService: ConfigService) {
    const get = (key: string): string | undefined => this.configService.get<string>(key);
    this.provider = resolveSmsProvider(get);
    this.awsOrigination = get('SMS_AWS_ORIGINATION_IDENTITY')?.trim() ?? '';
    this.awsConfigurationSet = get('SMS_AWS_CONFIGURATION_SET')?.trim() || undefined;
    this.awsProtectConfiguration = get('SMS_AWS_PROTECT_CONFIGURATION_ID')?.trim() || undefined;
    // Egypt-only by default: a second line of defence against SMS pumping next to the AWS
    // protect configuration. Comma-separated E.164 prefixes.
    this.allowedPrefixes = (get('SMS_ALLOWED_COUNTRY_PREFIXES') ?? '+20')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');

    if (this.provider === 'aws') {
      if (this.awsOrigination === '') {
        this.logger.warn('SMS_PROVIDER=aws but SMS_AWS_ORIGINATION_IDENTITY is not set - SMS sending disabled');
      } else {
        this.awsClient = new PinpointSMSVoiceV2Client({
          region: get('SMS_REGION') || get('AWS_REGION') || 'eu-central-1',
        });
        this.logger.log('AWS End User Messaging SMS client initialized');
      }
    }

    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') ?? '';

    if (this.provider === 'twilio') {
      if (
        accountSid !== undefined &&
        accountSid !== '' &&
        authToken !== undefined &&
        authToken !== ''
      ) {
        this.twilioClient = twilio(accountSid, authToken);
        this.logger.log('Twilio client initialized successfully');
      } else {
        this.logger.warn('SMS_PROVIDER=twilio but credentials are not configured - SMS sending disabled');
      }
    } else if (this.provider === 'none') {
      this.logger.warn('No SMS provider configured - SMS sending disabled');
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
    if (!this.twilioClient && !this.awsClient) {
      this.logger.warn('SMS not sent - no SMS provider configured');
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

    if (this.awsClient !== null) return await this.sendViaAws(this.awsClient, formattedPhone, message);
    if (this.twilioClient === null) return { success: false, error: 'SMS service not configured' };

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

  /** AWS End User Messaging SMS. Transactional only (OTP and critical notices). */
  private async sendViaAws(
    client: PinpointSMSVoiceV2Client,
    to: string,
    message: string,
  ): Promise<SmsResult> {
    if (!this.allowedPrefixes.some((prefix) => to.startsWith(prefix))) {
      this.logger.warn(`SMS refused: destination outside the allowed countries (${maskPhone(to) ?? '***'})`);
      return { success: false, error: 'Destination country is not allowed' };
    }
    try {
      const result = await client.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: to,
          OriginationIdentity: this.awsOrigination,
          MessageBody: message,
          MessageType: 'TRANSACTIONAL',
          ...(this.awsConfigurationSet !== undefined ? { ConfigurationSetName: this.awsConfigurationSet } : {}),
          ...(this.awsProtectConfiguration !== undefined
            ? { ProtectConfigurationId: this.awsProtectConfiguration }
            : {}),
        }),
      );
      this.logger.log(`SMS sent successfully to ${maskPhone(to) ?? '***'}: ${result.MessageId ?? 'no-id'}`);
      return { success: true, ...(result.MessageId !== undefined ? { messageId: result.MessageId } : {}) };
    } catch (error) {
      // The error name (e.g. ConflictException/ThrottlingException) is useful; the body is not logged.
      const name = error instanceof Error ? error.name : 'Unknown error';
      this.logger.error(`Failed to send SMS to ${maskPhone(to) ?? '***'}: ${name}`);
      return { success: false, error: name };
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
    return this.twilioClient !== null || this.awsClient !== null;
  }

  public get providerName(): SmsProvider {
    return this.awsClient !== null ? 'aws' : this.twilioClient !== null ? 'twilio' : 'none';
  }
}
