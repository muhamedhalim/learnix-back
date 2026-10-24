import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { maskEmail } from '../common/utils/mask.util';
import {
  applyStagingSubjectPrefix,
  evaluateMailRecipient,
} from '../common/utils/staging-messaging-guard.util';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { performanceMetrics } from '../observability/performance-metrics.registry';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { EmailSuppression } from './entities/email-suppression.entity';
import { renderInvitationEmail } from './local-templates';
import { MailDeliveryException } from './mail-delivery.exception';
import {
  classifySesError,
  resolveSesConfig,
  SesTransport,
  type ResolvedSesConfig,
  type SesRuntimeState,
} from './ses.transport';

export interface MailMessage {
  to: string;
  recipientName?: string;
  subject?: string;
  html?: string;
  text?: string;
}

/** JSON-only payload that crosses the BullMQ boundary. */
export interface MailJob extends MailMessage {
  /** Optional notification delivery leg updated by MailProcessor. */
  notificationDeliveryId?: string;
}

export interface MailDeliveryResult {
  accepted: boolean;
  providerMessageId?: string;
  reason?: string;
}

export interface TemplateEmailInput {
  to: string;
  recipientName?: string;
  locale?: PreferredLanguage;
  personalization?: Record<string, unknown>;
}

export type MailTemplateName =
  | 'welcome'
  | 'passwordReset'
  | 'verification'
  | 'invitation'
  | 'paymentConfirmation'
  | 'invoice'
  | 'certificate'
  | 'homework'
  | 'exam'
  | 'subscription';

/** Amazon SES is the only email provider. `none` means MAIL_PROVIDER is unset (local and test runs). */
export type MailProviderName = 'ses' | 'none';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly sesConfig: ResolvedSesConfig;
  private readonly ses: SesTransport | null;
  private providerObservation: {
    state: SesRuntimeState;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };

  public constructor(
    private readonly configService: ConfigService,
    @InjectQueue(QUEUE_NAMES.EMAIL) private readonly emailQueue: Queue<MailJob>,
    @InjectRepository(EmailSuppression)
    private readonly suppressions: Repository<EmailSuppression>,
  ) {
    this.sesConfig = resolveSesConfig((key) => this.configService.get<string>(key));
    this.ses = this.sesConfig.configured ? new SesTransport(this.sesConfig) : null;
    this.providerObservation = {
      state: this.sesConfig.state,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    };

    if (!this.sesConfig.enabled) {
      this.logger.log('Email provider is disabled because MAIL_PROVIDER is not "ses".');
    } else if (this.ses === null) {
      this.logger.warn(
        `Amazon SES is selected but required configuration is missing: ${this.sesConfig.missing.join(', ')}.`,
      );
    } else {
      this.logger.log('Amazon SES email provider initialized.');
    }
  }

  /** Which provider delivers mail. */
  public get providerName(): MailProviderName {
    return this.sesConfig.enabled ? 'ses' : 'none';
  }

  public isConfigured(): boolean {
    return this.ses !== null;
  }

  public getHealthStatus(): {
    state: SesRuntimeState;
    enabled: boolean;
    configured: boolean;
    missing: string[];
    probeExecuted: false;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  } {
    return {
      state: this.providerObservation.state,
      enabled: this.sesConfig.enabled,
      configured: this.sesConfig.configured,
      missing: [...this.sesConfig.missing],
      probeExecuted: false,
      lastAttemptAt: this.providerObservation.lastAttemptAt,
      lastSuccessAt: this.providerObservation.lastSuccessAt,
      lastFailureAt: this.providerObservation.lastFailureAt,
    };
  }

  /** No message-generating probe: initialization verifies configuration, real sends verify delivery. */
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
   * SES is called exclusively by MailProcessor.
   */
  public async send(message: MailJob): Promise<boolean> {
    if (!this.isConfigured()) {
      this.logger.warn(
        this.logDetails('skipped', message, { reason: 'Email provider is not configured' }),
      );
      return false;
    }

    try {
      this.providerObservation.lastAttemptAt = new Date().toISOString();
      const job = await this.emailQueue.add(JOB_TYPES.EMAIL.DELIVER, message);
      if (!job?.id) {
        this.logger.warn(
          this.logDetails('queue_unavailable', message, {
            reason: 'No durable email job was created',
          }),
        );
        return false;
      }
      this.logger.log(this.logDetails('enqueued', message));
      return true;
    } catch (error) {
      performanceMetrics.recordFailure('email');
      this.logger.error(
        this.logDetails('enqueue_failed', message, {
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
      throw new MailDeliveryException('Email could not be queued for delivery.');
    }
  }

  /** Called only by the BullMQ worker. Never call this from a controller or domain service. */
  public async deliver(message: MailJob): Promise<MailDeliveryResult> {
    if (this.ses === null) {
      throw new MailDeliveryException('Email delivery worker is not configured.');
    }

    // Staging-only enforcement of MAIL_ALLOWLIST — inert on production (see
    // staging-messaging-guard.util.ts). This is the single funnel every
    // outbound email passes through, so one check here covers every call
    // site in this file. Blocked sends are logged and treated as a completed
    // job, never thrown, so the BullMQ worker does not retry a send that was
    // deliberately refused.
    const envGet = (key: string): string | undefined => this.configService.get<string>(key);
    const recipientDecision = evaluateMailRecipient(envGet, message.to);
    if (recipientDecision.blocked) {
      this.logger.warn(
        this.logDetails('blocked_staging_allowlist', message, { reason: recipientDecision.reason }),
      );
      return {
        accepted: false,
        ...(recipientDecision.reason === undefined ? {} : { reason: recipientDecision.reason }),
      };
    }

    // F-34: never mail an address that permanently bounced or complained. Treated as a completed job
    // (not an error) so BullMQ does not retry a send that is deliberately refused.
    if (await this.suppressions.exists({ where: { email: message.to.trim().toLowerCase() } })) {
      this.logger.warn(this.logDetails('blocked_suppressed', message, { reason: 'suppressed' }));
      return { accepted: false, reason: 'suppressed' };
    }

    const attemptedAt = new Date().toISOString();
    this.providerObservation = {
      ...this.providerObservation,
      lastAttemptAt: attemptedAt,
    };

    try {
      if (
        message.subject === undefined ||
        (message.html === undefined && message.text === undefined)
      ) {
        // Every message is rendered in this codebase; refuse rather than send an empty mail.
        throw new MailDeliveryException('Email has no subject or body for SES delivery.');
      }
      const providerMessageId = await this.ses.send({
        to: message.to,
        recipientName: message.recipientName,
        subject: applyStagingSubjectPrefix(envGet, message.subject),
        text: message.text,
        html: message.html,
      });
      this.providerObservation = {
        state: 'configured',
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date().toISOString(),
        lastFailureAt: this.providerObservation.lastFailureAt,
      };
      this.logger.log(this.logDetails('sent', message, { requestId: providerMessageId }));
      return { accepted: true, ...(providerMessageId === null ? {} : { providerMessageId }) };
    } catch (error) {
      this.providerObservation = {
        state: classifySesError(error),
        lastAttemptAt: attemptedAt,
        lastSuccessAt: this.providerObservation.lastSuccessAt,
        lastFailureAt: new Date().toISOString(),
      };
      performanceMetrics.recordFailure('email');
      this.logger.error(
        this.logDetails('send_failed', message, {
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
      throw new MailDeliveryException('Email delivery failed.');
    }
  }

  public async sendWelcomeEmail(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('welcome', input, 'Welcome to Learnix');
  }

  public async sendPasswordResetEmail(
    to: string,
    name: string,
    resetUrl: string,
    expiresInLabel: string,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<boolean> {
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
    return await this.sendRendered('verification', input, 'Verify your Learnix login');
  }

  public async sendInvitationEmail(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('invitation', input, 'You are invited to Learnix');
  }

  public async sendPaymentConfirmation(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('paymentConfirmation', input, 'Payment confirmation');
  }

  public async sendInvoice(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('invoice', input, 'Your Learnix invoice');
  }

  public async sendCertificateIssued(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('certificate', input, 'Your Learnix certificate');
  }

  public async sendHomeworkAssigned(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('homework', input, 'New homework assigned');
  }

  public async sendExamScheduled(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('exam', input, 'Exam scheduled');
  }

  public async sendSubscriptionExpiring(input: TemplateEmailInput): Promise<boolean> {
    return await this.sendRendered('subscription', input, 'Your subscription is expiring');
  }

  private async sendRendered(
    template: MailTemplateName,
    input: TemplateEmailInput,
    englishSubject: string,
  ): Promise<boolean> {
    const { locale = PreferredLanguage.EN, personalization, ...mailInput } = input;
    if (template === 'invitation') {
      const rendered = renderInvitationEmail(mailInput.recipientName, locale, personalization);
      if (rendered !== null) return await this.send({ ...mailInput, ...rendered });
    }
    const subject = this.localizedSubject(template, englishSubject, locale);
    return await this.send({
      ...mailInput,
      subject,
      text: subject,
      html: `<p dir="${locale === PreferredLanguage.AR ? 'rtl' : 'ltr'}">${subject}</p>`,
    });
  }

  private localizedSubject(
    template: MailTemplateName,
    englishSubject: string,
    locale: PreferredLanguage,
  ): string {
    if (locale !== PreferredLanguage.AR) return englishSubject;
    const arabicSubjects: Record<MailTemplateName, string> = {
      welcome: 'مرحبًا بك في Learnix',
      passwordReset: 'إعادة تعيين كلمة المرور',
      verification: 'تحقق من تسجيل الدخول إلى Learnix',
      invitation: 'لديك دعوة إلى Learnix',
      paymentConfirmation: 'تأكيد الدفع',
      invoice: 'فاتورة Learnix الخاصة بك',
      certificate: 'شهادة Learnix الخاصة بك',
      homework: 'تم تعيين واجب جديد',
      exam: 'تمت جدولة اختبار',
      subscription: 'اشتراكك على وشك الانتهاء',
    };
    return arabicSubjects[template];
  }

  private logDetails(
    status: string,
    message: MailMessage,
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      provider: this.providerName,
      status,
      recipient: maskEmail(message.to) ?? 'unknown',
      ...extra,
    });
  }
}
