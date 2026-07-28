import { classifyMailerSendError, resolveMailerSendConfig } from './mailersend.config';

describe('MailerSend configuration resolver', () => {
  it('resolves the production configuration from the shared environment names', () => {
    const values: Record<string, string> = {
      MAIL_PROVIDER: 'mailersend',
      MAILERSEND_API_KEY: 'secret',
      MAIL_FROM_EMAIL: 'no-reply@example.test',
      MAIL_FROM_NAME: 'Learnix',
      MAIL_REPLY_TO: 'support@example.test',
      MAILERSEND_TEMPLATE_WELCOME: 'welcome-template',
    };
    const result = resolveMailerSendConfig((key) => values[key]);
    expect(result).toMatchObject({
      state: 'configured',
      configured: true,
      replyTo: 'support@example.test',
      templateIds: { welcome: 'welcome-template' },
    });
  });

  it('reports a missing API key only when MailerSend is enabled', () => {
    const values: Record<string, string> = {
      MAIL_PROVIDER: 'mailersend',
      MAIL_FROM_EMAIL: 'no-reply@example.test',
      MAIL_FROM_NAME: 'Learnix',
    };
    expect(resolveMailerSendConfig((key) => values[key])).toMatchObject({
      state: 'misconfigured',
      missing: ['MAILERSEND_API_KEY'],
    });
  });

  it('does not initialize provider configuration when disabled', () => {
    expect(resolveMailerSendConfig(() => undefined)).toMatchObject({
      state: 'disabled',
      enabled: false,
      missing: [],
    });
  });

  it('classifies authentication, rate limit, and availability errors', () => {
    expect(classifyMailerSendError({ response: { status: 401 } })).toBe('authentication_failed');
    expect(classifyMailerSendError({ statusCode: 429 })).toBe('rate_limited');
    expect(classifyMailerSendError(new Error('network'))).toBe('provider_unavailable');
  });
});
