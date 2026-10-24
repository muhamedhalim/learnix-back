import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { mockClient } from 'aws-sdk-client-mock';

import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { JOB_TYPES } from '../queues/queues.constants';
import { MailService, type MailJob } from './mail.service';

describe('MailService', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => {
    ses.reset();
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
  });

  const configuredValues: Record<string, string> = {
    MAIL_PROVIDER: 'ses',
    MAIL_FROM_EMAIL: 'no-reply@example.test',
    MAIL_FROM_NAME: 'Learnix',
    MAIL_REPLY_TO: 'support@example.test',
  };

  function createService(values = configuredValues): {
    service: MailService;
    queue: { add: jest.Mock };
  } {
    const queue = { add: jest.fn().mockResolvedValue({ id: 'mail-job-1' }) };
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    return {
      service: new MailService(
        config as unknown as ConfigService,
        queue as unknown as Queue<MailJob>,
        { exists: jest.fn().mockResolvedValue(false) } as never,
      ),
      queue,
    };
  }

  const sentInput = () => ses.commandCalls(SendEmailCommand)[0]?.args[0].input;

  it('queues a rendered password reset with the link in both text and HTML', async () => {
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
        subject: 'Reset your password',
        text: expect.stringContaining('https://app.example.test/reset?token=secret'),
        html: expect.stringContaining('href="https://app.example.test/reset?token=secret"'),
      }),
    );
    const job = queue.add.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(job).not.toHaveProperty('templateId');
    expect(job).not.toHaveProperty('personalization');
  });

  it('does not report acceptance when the queue creates no durable job', async () => {
    const { service, queue } = createService();
    queue.add.mockResolvedValue(null);

    await expect(
      service.send({ to: 'student@example.test', subject: 'Update', text: 'Body' }),
    ).resolves.toBe(false);
  });

  it('sends through SES with sender, reply-to and configuration set', async () => {
    const { service } = createService({
      ...configuredValues,
      SES_CONFIGURATION_SET: 'learnix-test',
    });

    await expect(
      service.deliver({
        to: 'student@example.test',
        recipientName: 'Student',
        subject: 'Hi',
        text: 'Hi',
      }),
    ).resolves.toEqual({ accepted: true, providerMessageId: 'ses-1' });

    expect(sentInput()).toMatchObject({
      FromEmailAddress: 'Learnix <no-reply@example.test>',
      Destination: { ToAddresses: ['Student <student@example.test>'] },
      ReplyToAddresses: ['support@example.test'],
      ConfigurationSetName: 'learnix-test',
    });
    expect(service.getHealthStatus()).toMatchObject({
      state: 'configured',
      lastAttemptAt: expect.any(String),
      lastSuccessAt: expect.any(String),
      lastFailureAt: null,
    });
  });

  it('localizes Arabic subjects for rendered messages', async () => {
    const { service, queue } = createService();
    await service.sendWelcomeEmail({ to: 'student@example.test', locale: PreferredLanguage.AR });
    expect(queue.add).toHaveBeenCalledWith(
      JOB_TYPES.EMAIL.DELIVER,
      expect.objectContaining({
        subject: 'مرحبًا بك في Learnix',
        html: expect.stringContaining('dir="rtl"'),
      }),
    );
  });

  it('blocks delivery to a non-allowlisted recipient on staging without calling SES', async () => {
    const { service } = createService({
      ...configuredValues,
      APP_ENV: 'staging',
      MAIL_ALLOWLIST: 'tester@example.com',
    });

    await service.deliver({ to: 'real.student@gmail.com', subject: 'Hi', text: 'Hi' });

    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('delivers for real to an allowlisted recipient on staging, with a [STAGING] subject prefix', async () => {
    const { service } = createService({
      ...configuredValues,
      APP_ENV: 'staging',
      MAIL_ALLOWLIST: 'tester@example.com',
    });

    await service.deliver({ to: 'tester@example.com', subject: 'Hi', text: 'Hi' });

    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(sentInput()?.Content?.Simple?.Subject?.Data).toBe('[STAGING] Hi');
  });

  it('does not block anything on production (default APP_ENV)', async () => {
    const { service } = createService(configuredValues);

    await service.deliver({ to: 'anyone@gmail.com', subject: 'Hi', text: 'Hi' });

    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(sentInput()?.Content?.Simple?.Subject?.Data).toBe('Hi');
  });

  it.each([{}, { MAIL_PROVIDER: 'smtp' }, { MAIL_PROVIDER: 'mailersend' }])(
    'sends nothing unless MAIL_PROVIDER=ses (%j)',
    async (values) => {
      const { service, queue } = createService(values as Record<string, string>);

      await expect(
        service.send({ to: 'student@example.test', subject: 'Ignored', text: 'Ignored' }),
      ).resolves.toBe(false);
      expect(service.isConfigured()).toBe(false);
      expect(service.providerName).toBe('none');
      expect(queue.add).not.toHaveBeenCalled();
    },
  );
});
