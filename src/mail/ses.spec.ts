import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { mockClient } from 'aws-sdk-client-mock';

import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { renderInvitationEmail } from './local-templates';
import { parseSesFeedback } from './mail-events.consumer';
import { MailService } from './mail.service';
import {
  classifySesError,
  formatAddress,
  resolveSesConfig,
  SesTransport,
} from './ses.transport';

const reader = (env: Record<string, string>) => (key: string) => env[key];

describe('resolveSesConfig', () => {
  it('is disabled unless MAIL_PROVIDER=ses', () => {
    expect(resolveSesConfig(reader({})).enabled).toBe(false);
    expect(resolveSesConfig(reader({ MAIL_PROVIDER: 'smtp' })).enabled).toBe(false);
  });

  it('needs only a sender (credentials come from the task role)', () => {
    expect(resolveSesConfig(reader({ MAIL_PROVIDER: 'ses' }))).toMatchObject({
      state: 'misconfigured',
      missing: ['MAIL_FROM_EMAIL'],
    });
    expect(
      resolveSesConfig(reader({ MAIL_PROVIDER: 'SES', MAIL_FROM_EMAIL: 'no-reply@learnix.school' })),
    ).toMatchObject({ state: 'configured', configured: true, region: 'eu-central-1' });
  });
});

describe('formatAddress', () => {
  it('keeps plain ASCII names readable and encodes Arabic names (RFC 2047)', () => {
    expect(formatAddress('a@b.test', 'Learnix')).toBe('Learnix <a@b.test>');
    const arabic = formatAddress('a@b.test', 'أكاديمية');
    expect(arabic).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@b.test>$/);
    expect(Buffer.from(arabic.split('?')[3]!, 'base64').toString('utf8')).toBe('أكاديمية');
  });

  it('cannot be used to inject headers', () => {
    expect(formatAddress('a@b.test', 'x\r\nBcc: evil@x.test')).not.toMatch(/[\r\n]/);
  });

  it('quotes-unsafe names are encoded rather than emitted raw', () => {
    expect(formatAddress('a@b.test', 'Bob <evil@x.test>')).toMatch(/^=\?UTF-8\?B\?/);
  });
});

describe('SesTransport', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  const config = resolveSesConfig(
    reader({
      MAIL_PROVIDER: 'ses',
      MAIL_FROM_EMAIL: 'no-reply@learnix.school',
      MAIL_FROM_NAME: 'Learnix',
      MAIL_REPLY_TO: 'help@learnix.school',
      SES_CONFIGURATION_SET: 'learnix-prod',
    }),
  );

  it('sends UTF-8 html and text through the configuration set', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-123' });
    const id = await new SesTransport(config, new SESv2Client({ region: 'eu-central-1' })).send({
      to: 'student@example.test',
      recipientName: 'طالب',
      subject: 'موضوع',
      html: '<p>مرحبا</p>',
      text: 'مرحبا',
    });
    expect(id).toBe('ses-123');
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(input.FromEmailAddress).toBe('Learnix <no-reply@learnix.school>');
    expect(input.ReplyToAddresses).toEqual(['help@learnix.school']);
    expect(input.ConfigurationSetName).toBe('learnix-prod');
    expect(input.Content!.Simple!.Subject!.Charset).toBe('UTF-8');
    expect(input.Content!.Simple!.Body!.Html!.Data).toBe('<p>مرحبا</p>');
  });
});

describe('classifySesError', () => {
  it.each([
    ['TooManyRequestsException', 'rate_limited'],
    ['AccountSuspendedException', 'authentication_failed'],
    ['MailFromDomainNotVerifiedException', 'authentication_failed'],
    ['InternalServiceErrorException', 'provider_unavailable'],
  ])('%s -> %s', (name, state) => {
    expect(classifySesError({ name })).toBe(state);
  });
});

describe('MailService with SES', () => {
  const ses = mockClient(SESv2Client);
  beforeEach(() => ses.reset());

  const make = (env: Record<string, string>) => {
    const queue = { add: jest.fn().mockResolvedValue({ id: '1' }) };
    const service = new MailService({ get: (key: string) => env[key] } as never, queue as never);
    return { service, queue };
  };
  const sesEnv = { MAIL_PROVIDER: 'ses', MAIL_FROM_EMAIL: 'no-reply@learnix.school', MAIL_FROM_NAME: 'Learnix' };

  it('reports itself as the SES provider and is configured without any API key', () => {
    const { service } = make(sesEnv);
    expect(service.providerName).toBe('ses');
    expect(service.isConfigured()).toBe(true);
    expect(service.getHealthStatus()).toMatchObject({ enabled: true, configured: true });
  });

  it('is not configured when selected without a sender', () => {
    const { service } = make({ MAIL_PROVIDER: 'ses' });
    expect(service.isConfigured()).toBe(false);
    expect(service.getHealthStatus().missing).toEqual(['MAIL_FROM_EMAIL']);
  });

  it('delivers through SES and returns the provider message id', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-777' });
    const { service } = make(sesEnv);
    const result = await service.deliver({ to: 'a@b.test', subject: 'Hi', text: 'hi', html: '<p>hi</p>' });
    expect(result).toEqual({ accepted: true, providerMessageId: 'ses-777' });
  });

  it('refuses to send a body-less message instead of sending an empty email', async () => {
    const { service } = make(sesEnv);
    await expect(service.deliver({ to: 'a@b.test', subject: 'No body' })).rejects.toThrow(/failed/i);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it('turns an SES failure into a delivery failure with a classified state', async () => {
    ses.on(SendEmailCommand).rejects(Object.assign(new Error('paused'), { name: 'SendingPausedException' }));
    const { service } = make(sesEnv);
    await expect(service.deliver({ to: 'a@b.test', subject: 'Hi', text: 'hi' })).rejects.toThrow();
    expect(service.getHealthStatus().state).toBe('authentication_failed');
  });

  it('sends the instructor invitation with the repo-local template (no remote template needed)', async () => {
    const { service, queue } = make(sesEnv);
    await service.sendInvitationEmail({
      to: 'inst@example.test',
      recipientName: 'Sara',
      locale: PreferredLanguage.AR,
      personalization: { setupUrl: 'https://learnix.school/auth/reset-password?token=abc', expiresAt: '2026-10-12T10:00:00.000Z' },
    });
    const job = queue.add.mock.calls[0]![1] as { subject: string; html: string };
    expect(job.subject).toBe('لديك دعوة إلى Learnix');
    expect(job.html).toContain('dir="rtl"');
    expect(job.html).toContain('token=abc');
  });
});

describe('renderInvitationEmail', () => {
  it('refuses a missing or non-http link', () => {
    expect(renderInvitationEmail('A', PreferredLanguage.EN, {})).toBeNull();
    expect(renderInvitationEmail('A', PreferredLanguage.EN, { setupUrl: 'javascript:alert(1)' })).toBeNull();
  });

  it('escapes the recipient name', () => {
    const mail = renderInvitationEmail('<script>x</script>', PreferredLanguage.EN, {
      setupUrl: 'https://learnix.school/a?b=1&c=2',
    });
    expect(mail!.html).not.toContain('<script>');
    expect(mail!.html).toContain('&lt;script&gt;');
    expect(mail!.html).toContain('b=1&amp;c=2');
  });
});

describe('parseSesFeedback', () => {
  const wrap = (message: unknown) => JSON.stringify({ Type: 'Notification', Message: JSON.stringify(message) });

  it('reads a permanent bounce from an SNS-wrapped event', () => {
    expect(
      parseSesFeedback(
        wrap({ eventType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'x@y.test' }] } }),
      ),
    ).toEqual({ kind: 'bounce', permanent: true, recipients: ['x@y.test'] });
  });

  it('reads a transient bounce and a complaint', () => {
    expect(
      parseSesFeedback(
        wrap({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'x@y.test' }] } }),
      )?.permanent,
    ).toBe(false);
    expect(
      parseSesFeedback(wrap({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'c@y.test' }] } })),
    ).toEqual({ kind: 'complaint', permanent: true, recipients: ['c@y.test'] });
  });

  it('ignores deliveries and garbage', () => {
    expect(parseSesFeedback(wrap({ eventType: 'Delivery' }))).toBeNull();
    expect(parseSesFeedback('not json')).toBeNull();
  });
});
