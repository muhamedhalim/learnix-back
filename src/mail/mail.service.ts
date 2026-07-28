import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EmailParams, MailerSend, Recipient, Sender } from 'mailersend';
import type { Queue } from 'bullmq';

import { maskEmail } from '../common/utils/mask.util';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { performanceMetrics } from '../observability/performance-metrics.registry';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { MailDeliveryException } from './mail-delivery.exception';
import {
  classifyMailerSendError,
  resolveMailerSendConfig,
  type MailerSendRuntimeState,
  type MailTemplateName,
  type ResolvedMailerSendConfig,
} from './mailersend.config';

export interface MailMessage {
  to: string;
  recipientName?: string;
  subject?: string;
  html?: string;
  text?: string;
  templateId?: string;
  personalization?: Record<string, unknown>;
}

/** JSON-only payload that crosses the BullMQ boundary. */
export type MailJob = MailMessage;

export interface TemplateEmailInput {
  to: string;
  recipientName?: string;
  personalization?: Record<string, unknown>;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly client: MailerSend | null;
  private readonly from: Sender | null;
  private readonly replyTo: Recipient | null;
  private readonly resolvedConfig: ResolvedMailerSendConfig;
  private providerObservation: {
    state: MailerSendRuntimeState;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };

  public constructor(
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue<MailJob>,
  ) {
    this.resolvedConfig = resolveMailerSendConfig((key) => this.configService.get<string>(key));
    this.providerObservation = {
      state: this.resolvedConfig.state,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    };

    if (!this.resolvedConfig.enabled) {
      this.client = null;
      this.from = null;
      this.replyTo = null;
      this.logger.log('Email provider is disabled because MAIL_PROVIDER is not "mailersend".');
      return;
    }

    if (!this.resolvedConfig.configured) {
      this.client = null;
      this.from = null;
      this.replyTo = null;
      this.logger.warn(
        `MailerSend is selected but required configuration is missing: ${this.resolvedConfig.missing.join(', ')}.`,
      );
      return;
    }

    this.client = new MailerSend({ apiKey: this.resolvedConfig.apiKey ?? '' });
    this.from = new Sender(this.resolvedConfig.fromEmail ?? '', this.resolvedConfig.fromName ?? '');
    this.replyTo = this.resolvedConfig.replyTo ? new Recipient(this.resolvedConfig.replyTo) : null;
    this.logger.log('MailerSend email provider initialized.');
  }

  public isConfigured(): boolean {
    return this.client !== null && this.from !== null;
  }

  public getHealthStatus(): {
    state: MailerSendRuntimeState;
    enabled: boolean;
    configured: boolean;
    missing: string[];
    configuredTemplateCount: number;
    probeExecuted: false;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  } {
    return {
      state: this.providerObservation.state,
      enabled: this.resolvedConfig.enabled,
      configured: this.resolvedConfig.configured,
      missing: [...this.resolvedConfig.missing],
      configuredTemplateCount: Object.keys(this.resolvedConfig.templateIds).length,
      probeExecuted: false,
      lastAttemptAt: this.providerObservation.lastAttemptAt,
      lastSuccessAt: this.providerObservation.lastSuccessAt,
      lastFailureAt: this.providerObservation.lastFailureAt,
    };
  }

  /** MailerSend has no inexpensive authenticated health endpoint; initialization verifies configuration. */
  public async verifyConnectivity(): Promise<boolean> {
    if (!this.isConfigured()) {
      throw new MailDeliveryException('Email provider is not configured.');
    }
    return true;
  }

  /** Enqueues a clearly labelled, content-free diagnostic message. */
  public async sendHealthCheckEmail(to: string): Promise<boolean> {
    return await this.send({
      to,
      subject: 'Learnix system health test',
      text: 'This is a diagnostic email requested by an authorised Learnix administrator. No action is required.',
      html:
        '<p>This is a diagnostic email requested by an authorised Learnix administrator.</p>' +
        '<p>No action is required.</p>',
    });
  }

  /**
   * The public transport boundary. Domain services only enqueue work here;
   * MailerSend is called exclusively by MailProcessor.
   */
  public async send(message: MailMessage): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.warn(
        this.logDetails('skipped', message, { reason: 'MailerSend is not configured' }),
      );
      return false;
    }

    try {
      this.providerObservation.lastAttemptAt = new Date().toISOString();
      await this.emailQueue.add(JOB_TYPES.EMAIL.DELIVER, message);
      this.logger.log(this.logDetails('enqueued', message));
      return true;
    } catch (error) {
      performanceMetrics.recordFailure('email');
      this.logger.error(this.logDetails('enqueue_failed', message, this.errorDetails(error)));
      throw new MailDeliveryException('Email could not be queued for delivery.');
    }
  }

  /** Called only by the BullMQ worker. Never call this from a controller or domain service. */
  public async deliver(message: MailJob): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new MailDeliveryException('MailerSend delivery worker is not configured.');
    }

    const attemptedAt = new Date().toISOString();
    this.providerObservation = {
      ...this.providerObservation,
      lastAttemptAt: attemptedAt,
    };
    try {
      const email = new EmailParams()
        .setFrom(this.from)
        .setTo([new Recipient(message.to, message.recipientName)]);

      if (this.replyTo !== null) email.setReplyTo(this.replyTo);
      if (message.templateId !== undefined && message.templateId !== '') {
        email
          .setTemplateId(message.templateId)
          .setPersonalization([{ email: message.to, data: message.personalization ?? {} }]);
      } else {
        if (message.subject !== undefined) email.setSubject(message.subject);
        if (message.text !== undefined) email.setText(message.text);
        if (message.html !== undefined) email.setHtml(message.html);
      }

      const response = await this.client.email.send(email);
      this.providerObservation = {
        state: 'configured',
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: this.providerObservation.lastFailureAt,
      };
      this.logger.log(
        this.logDetails('sent', message, {
          responseStatus: response.statusCode,
          requestId: this.requestId(response.headers),
          response: response.body,
        }),
      );
    } catch (error) {
      this.providerObservation = {
        state: classifyMailerSendError(error),
        lastAttemptAt: attemptedAt,
        lastSuccessAt: this.providerObservation.lastSuccessAt,
        lastFailureAt: new Date().toISOString(),
      };
      performanceMetrics.recordFailure('email');
      this.logger.error(this.logDetails('send_failed', message, this.errorDetails(error)));
      throw new MailDeliveryException('Email delivery failed.');
    }
  }

  public async sendWelcomeEmail(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('welcome', input, 'Welcome to Learnix');
  }

  public async sendPasswordResetEmail(
    to: string,
    name: string,
    resetUrl: string,
    expiresInLabel: string,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<boolean> {
    const templateId = this.templateId('passwordReset');
    if (templateId !== undefined) {
      return await this.send({
        to,
        recipientName: name,
        templateId,
        personalization: { name, reset_url: resetUrl, expires_in: expiresInLabel, locale },
      });
    }

    const isArabic = locale === PreferredLanguage.AR;
    const subject = isArabic ? 'إعادة تعيين كلمة المرور' : 'Reset your password';
    const greeting =
      name.trim() === ''
        ? isArabic
          ? 'مرحباً'
          : 'Hello'
        : `${isArabic ? 'مرحباً' : 'Hello'} ${name.trim()}`;
    const intro = isArabic
      ? 'تلقينا طلباً لإعادة تعيين كلمة المرور. استخدم الرابط التالي لاختيار كلمة مرور جديدة:'
      : 'We received a request to reset your password. Use the link below to choose a new one:';
    const expiry = isArabic
      ? `تنتهي صلاحية هذا الرابط خلال ${expiresInLabel} ويمكن استخدامه مرة واحدة فقط.`
      : `This link expires in ${expiresInLabel} and can only be used once.`;
    const text = [`${greeting},`, '', intro, resetUrl, '', expiry].join('\n');
    const html = `<div dir="${isArabic ? 'rtl' : 'ltr'}" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937"><h2>${subject}</h2><p>${greeting},</p><p>${intro}</p><p><a href="${resetUrl}">${isArabic ? 'إعادة تعيين كلمة المرور' : 'Reset password'}</a></p><p>${expiry}</p></div>`;
    return await this.send({ to, recipientName: name, subject, text, html });
  }

  public async sendVerificationEmail(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('verification', input, 'Verify your Learnix login');
  }

  public async sendInvitationEmail(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('invitation', input, 'You are invited to Learnix');
  }

  public async sendPaymentConfirmation(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('paymentConfirmation', input, 'Payment confirmation');
  }

  public async sendInvoice(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('invoice', input, 'Your Learnix invoice');
  }

  public async sendCertificateIssued(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('certificate', input, 'Your Learnix certificate');
  }

  public async sendHomeworkAssigned(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('homework', input, 'New homework assigned');
  }

  public async sendExamScheduled(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate('exam', input, 'Exam scheduled');
  }

  public async sendSubscriptionExpiring(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendConfiguredTemplate(
      'subscription',
      input,
      'Your subscription is expiring',
    );
  }

  private async sendConfiguredTemplate(
    template: MailTemplateName,
    input: TemplateEmailInput,
    fallbackSubject: string,
  ): Promise<boolean> {
    const templateId = this.templateId(template);
    if (templateId !== undefined) {
      return await this.send({ ...input, templateId });
    }
    return await this.send({
      ...input,
      subject: fallbackSubject,
      text: fallbackSubject,
      html: `<p>${fallbackSubject}</p>`,
    });
  }

  private templateId(template: MailTemplateName): string | undefined {
    return this.resolvedConfig.templateIds[template];
  }

  private logDetails(
    status: string,
    message: MailMessage,
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      provider: 'mailersend',
      status,
      recipient: maskEmail(message.to) ?? 'unknown',
      templateId: message.templateId ?? null,
      ...extra,
    });
  }

  private errorDetails(error: unknown): Record<string, unknown> {
    if (typeof error === 'object' && error !== null && 'statusCode' in error) {
      const response = error as { statusCode?: unknown; headers?: unknown };
      return {
        responseStatus: response.statusCode ?? null,
        requestId: this.requestId(response.headers),
      };
    }
    return { responseStatus: null, requestId: null };
  }

  private requestId(headers: unknown): string | null {
    if (typeof headers !== 'object' || headers === null) return null;
    const record = headers as Record<string, unknown>;
    const requestId = record['x-request-id'] ?? record['X-Request-ID'] ?? record['x-message-id'];
    return typeof requestId === 'string' ? requestId : null;
  }
}
