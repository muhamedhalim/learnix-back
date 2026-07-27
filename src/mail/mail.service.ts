import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as nodemailer from 'nodemailer';

import { maskEmail } from '../common/utils/mask.util';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { performanceMetrics } from '../observability/performance-metrics.registry';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    const fromAddress =
      this.configService.get<string>('MAIL_FROM') ??
      this.configService.get<string>('SMTP_USER') ??
      'no-reply@learning-center.local';
    const fromName = this.configService.get<string>('MAIL_FROM_NAME') ?? 'Learning Center';
    this.from = `"${fromName}" <${fromAddress}>`;

    if (host === undefined || host === '') {
      this.transporter = null;
      this.logger.warn(
        'SMTP is not configured (SMTP_HOST missing). Emails will be logged, not sent.',
      );
      return;
    }

    const port = this.configService.get<number>('SMTP_PORT') ?? 587;
    const secure = this.configService.get<string>('SMTP_SECURE') === 'true' || port === 465;
    const user = this.configService.get<string>('SMTP_USER');
    const pass = this.configService.get<string>('SMTP_PASSWORD');

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user !== undefined && user !== '' ? { user, pass: pass ?? '' } : undefined,
    });
  }

  public isConfigured(): boolean {
    return this.transporter !== null;
  }

  /** Safe SMTP handshake used by the authenticated health indicator. */
  public async verifyConnectivity(): Promise<boolean> {
    if (this.transporter === null) return false;
    await this.transporter.verify();
    return true;
  }

  /** Sends a clearly labelled, content-free diagnostic message. */
  public async sendHealthCheckEmail(to: string): Promise<boolean> {
    return this.send({
      to,
      subject: 'Learnix system health test',
      text: 'This is a diagnostic email requested by an authorised Learnix administrator. No action is required.',
      html:
        '<p>This is a diagnostic email requested by an authorised Learnix administrator.</p>' +
        '<p>No action is required.</p>',
    });
  }

  public async send(options: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<boolean> {
    if (this.transporter === null) {
      this.logger.log(
        `[MAIL:DISABLED] To: ${options.to} | Subject: ${options.subject}\n${options.text}`,
      );
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
      return true;
    } catch (error) {
      performanceMetrics.recordFailure('email');
      this.logger.error(
        `Failed to send email to ${maskEmail(options.to) ?? 'unknown'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  public async sendPasswordResetEmail(
    to: string,
    name: string,
    resetUrl: string,
    expiresInLabel: string,
    locale: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<boolean> {
    if (locale === PreferredLanguage.AR) {
      return this.sendPasswordResetEmailAr(to, name, resetUrl, expiresInLabel);
    }
    return this.sendPasswordResetEmailEn(to, name, resetUrl, expiresInLabel);
  }

  private async sendPasswordResetEmailEn(
    to: string,
    name: string,
    resetUrl: string,
    expiresInLabel: string,
  ): Promise<boolean> {
    const subject = 'Reset your password';
    const greeting = name.trim() === '' ? 'Hello' : `Hello ${name.trim()}`;
    const text = [
      `${greeting},`,
      '',
      'We received a request to reset your password. Use the link below to choose a new one:',
      resetUrl,
      '',
      `This link expires in ${expiresInLabel} and can only be used once.`,
      "If you didn't request this, you can safely ignore this email — your password will not change.",
    ].join('\n');

    const html = `
      <div dir="ltr" style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937;">
        <h2 style="color: #111827;">Reset your password</h2>
        <p>${greeting},</p>
        <p>We received a request to reset your password. Click the button below to choose a new one:</p>
        <p style="text-align: center; margin: 28px 0;">
          <a href="${resetUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">Reset password</a>
        </p>
        <p style="font-size: 13px; color: #6b7280;">Or paste this link into your browser:<br/><a href="${resetUrl}">${resetUrl}</a></p>
        <p style="font-size: 13px; color: #6b7280;">This link expires in ${expiresInLabel} and can only be used once.</p>
        <p style="font-size: 13px; color: #6b7280;">If you didn't request this, you can safely ignore this email — your password will not change.</p>
      </div>
    `;

    return this.send({ to, subject, html, text });
  }

  private async sendPasswordResetEmailAr(
    to: string,
    name: string,
    resetUrl: string,
    expiresInLabel: string,
  ): Promise<boolean> {
    const subject = 'إعادة تعيين كلمة المرور';
    const greeting = name.trim() === '' ? 'مرحبًا' : `مرحبًا ${name.trim()}`;
    const text = [
      `${greeting}،`,
      '',
      'تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بك. استخدم الرابط أدناه لاختيار كلمة مرور جديدة:',
      resetUrl,
      '',
      `تنتهي صلاحية هذا الرابط خلال ${expiresInLabel} ويمكن استخدامه مرة واحدة فقط.`,
      'إذا لم تطلب هذا، يمكنك تجاهل هذا البريد الإلكتروني بأمان — لن يتم تغيير كلمة المرور الخاصة بك.',
    ].join('\n');

    const html = `
      <div dir="rtl" style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2937; text-align: right;">
        <h2 style="color: #111827;">إعادة تعيين كلمة المرور</h2>
        <p>${greeting}،</p>
        <p>تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بك. اضغط على الزر أدناه لاختيار كلمة مرور جديدة:</p>
        <p style="text-align: center; margin: 28px 0;">
          <a href="${resetUrl}" style="background: #2563eb; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block;">إعادة تعيين كلمة المرور</a>
        </p>
        <p style="font-size: 13px; color: #6b7280;">أو الصق هذا الرابط في متصفحك:<br/><a href="${resetUrl}">${resetUrl}</a></p>
        <p style="font-size: 13px; color: #6b7280;">تنتهي صلاحية هذا الرابط خلال ${expiresInLabel} ويمكن استخدامه مرة واحدة فقط.</p>
        <p style="font-size: 13px; color: #6b7280;">إذا لم تطلب هذا، يمكنك تجاهل هذا البريد الإلكتروني بأمان — لن يتم تغيير كلمة المرور الخاصة بك.</p>
      </div>
    `;

    return this.send({ to, subject, html, text });
  }
}
