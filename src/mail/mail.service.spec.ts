import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';

import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { JOB_TYPES } from '../queues/queues.constants';
import { MailService, type MailJob } from './mail.service';

describe('MailService', () => {
  const configuredValues: Record<string, string> = {
    MAIL_PROVIDER: 'mailersend',
    MAILERSEND_API_KEY: 'test-api-key',
    MAIL_FROM_EMAIL: 'no-reply@example.test',
    MAIL_FROM_NAME: 'Learnix',
    MAIL_REPLY_TO: 'support@example.test',
    MAILERSEND_TEMPLATE_PASSWORD_RESET: 'template-password-reset',
  };

  function createService(values = configuredValues): {
    service: MailService;
    queue: { add: jest.Mock };
  } {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    return {
      service: new MailService(
        config as unknown as ConfigService,
        queue as unknown as Queue<MailJob>,
      ),
      queue,
    };
  }

  it('queues template-backed password resets with personalization and no HTML', async () => {
    const { service, queue } = createService();

    await service.sendPasswordResetEmail(
      'student@example.test',
      'Student',
      'https://app.example.test/reset?token=secret',
      '1 hour',
      PreferredLanguage.EN,
    );

    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.EMAIL.DELIVER,
      expect.objectContaining({
        to: 'student@example.test',
        templateId: 'template-password-reset',
        personalization: {
          name: 'Student',
          reset_url: 'https://app.example.test/reset?token=secret',
          expires_in: '1 hour',
          locale: PreferredLanguage.EN,
        },
      }),
    );
    expect(queue.add.mock.calls[0]?.[1]).not.toHaveProperty('html');
  });

  it('builds MailerSend template requests with sender, reply-to, and personalization', async () => {
    const { service } = createService();
    const send = jest.fn().mockResolvedValue({
      statusCode: 202,
      headers: { 'x-request-id': 'request-123' },
    });
    (service as unknown as { client: { email: { send: jest.Mock } } }).client = {
      email: { send },
    };

    await service.deliver({
      to: 'student@example.test',
      recipientName: 'Student',
      templateId: 'template-password-reset',
      personalization: { reset_url: 'https://app.example.test/reset' },
    });

    const params = send.mock.calls[0]?.[0] as {
      from?: { email: string; name?: string };
      reply_to?: { email: string };
      template_id?: string;
      personalization?: unknown;
      html?: string;
    };
    expect(params.from).toEqual({ email: 'no-reply@example.test', name: 'Learnix' });
    expect(params.reply_to).toEqual({ email: 'support@example.test' });
    expect(params.template_id).toBe('template-password-reset');
    expect(params.personalization).toEqual([
      { email: 'student@example.test', data: { reset_url: 'https://app.example.test/reset' } },
    ]);
    expect(params.html).toBeUndefined();
    expect(service.getHealthStatus()).toMatchObject({
      state: 'configured',
      lastAttemptAt: expect.any(String),
      lastSuccessAt: expect.any(String),
      lastFailureAt: null,
    });
  });

  it('passes a recipient locale to configured templates and localizes Arabic fallbacks', async () => {
    const { service, queue } = createService({
      ...configuredValues,
      MAILERSEND_TEMPLATE_WELCOME: 'template-welcome',
    });

    await service.sendWelcomeEmail({
      to: 'student@example.test',
      locale: PreferredLanguage.AR,
      personalization: { name: 'طالب' },
    });
    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.EMAIL.DELIVER,
      expect.objectContaining({
        templateId: 'template-welcome',
        personalization: { name: 'طالب', locale: PreferredLanguage.AR },
      }),
    );

    const { service: fallback, queue: fallbackQueue } = createService({
      MAIL_PROVIDER: 'mailersend',
      MAILERSEND_API_KEY: 'test-api-key',
      MAIL_FROM_EMAIL: 'no-reply@example.test',
      MAIL_FROM_NAME: 'Learnix',
    });
    await fallback.sendWelcomeEmail({ to: 'student@example.test', locale: PreferredLanguage.AR });
    expect(fallbackQueue.add).toHaveBeenCalledWith(
      JOB_TYPES.EMAIL.DELIVER,
      expect.objectContaining({ subject: 'مرحبًا بك في Learnix', html: expect.stringContaining('dir="rtl"') }),
    );
  });

  it('does not initialize MailerSend for any other provider', async () => {
    const { service, queue } = createService({ MAIL_PROVIDER: 'smtp' });

    await expect(
      service.send({
        to: 'student@example.test',
        subject: 'Ignored',
        text: 'Ignored',
        html: '<p>Ignored</p>',
      }),
    ).resolves.toBe(false);
    expect(service.isConfigured()).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
