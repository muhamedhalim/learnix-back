import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import type { EnvReader } from '../common/utils/redis-connection.util';

export type SesRuntimeState =
  | 'disabled'
  | 'misconfigured'
  | 'configured'
  | 'authentication_failed'
  | 'provider_unavailable'
  | 'rate_limited';

export interface ResolvedSesConfig {
  state: 'disabled' | 'misconfigured' | 'configured';
  enabled: boolean;
  configured: boolean;
  missing: string[];
  region: string;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  configurationSet: string | null;
}

function value(get: EnvReader, key: string): string | null {
  const resolved = get(key)?.trim();
  return resolved === undefined || resolved === '' ? null : resolved;
}

/** `MAIL_PROVIDER=ses`. Credentials come from the task role; only the sender identity is configured. */
export function resolveSesConfig(get: EnvReader): ResolvedSesConfig {
  const enabled = value(get, 'MAIL_PROVIDER')?.toLowerCase() === 'ses';
  const fromEmail = value(get, 'MAIL_FROM_EMAIL');
  const missing = enabled && fromEmail === null ? ['MAIL_FROM_EMAIL'] : [];
  return {
    state: !enabled ? 'disabled' : missing.length === 0 ? 'configured' : 'misconfigured',
    enabled,
    configured: enabled && missing.length === 0,
    missing,
    region: value(get, 'SES_REGION') ?? value(get, 'AWS_REGION') ?? 'eu-central-1',
    fromEmail,
    fromName: value(get, 'MAIL_FROM_NAME'),
    replyTo: value(get, 'MAIL_REPLY_TO'),
    configurationSet: value(get, 'SES_CONFIGURATION_SET'),
  };
}

/** RFC 2047 encoded-word for display names, so Arabic names survive transport. */
export function formatAddress(email: string, name?: string | null): string {
  const display = name?.trim();
  if (display === undefined || display === '') return email;
  const safe = display.replace(/[\r\n]/g, ' ');
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]*$/.test(safe) && !/["\\<>@,;:]/.test(safe);
  const encoded = ascii ? safe : `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
  return `${encoded} <${email}>`;
}

export function classifySesError(
  error: unknown,
): Exclude<SesRuntimeState, 'disabled' | 'misconfigured' | 'configured'> {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const name = typeof record['name'] === 'string' ? record['name'] : '';
  const meta = (record['$metadata'] ?? {}) as { httpStatusCode?: number };
  if (
    ['TooManyRequestsException', 'ThrottlingException', 'LimitExceededException'].includes(name) ||
    meta.httpStatusCode === 429
  ) {
    return 'rate_limited';
  }
  if (
    [
      'AccountSuspendedException',
      'SendingPausedException',
      'MailFromDomainNotVerifiedException',
      'AccessDeniedException',
      'UnrecognizedClientException',
      'MessageRejected',
    ].includes(name) ||
    meta.httpStatusCode === 403
  ) {
    return 'authentication_failed';
  }
  return 'provider_unavailable';
}

export interface SesMessage {
  to: string;
  recipientName?: string | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
}

/** Sends one message through SES v2. Returns the SES MessageId. */
export class SesTransport {
  private readonly client: SESv2Client;

  constructor(private readonly config: ResolvedSesConfig, client?: SESv2Client) {
    this.client = client ?? new SESv2Client({ region: config.region });
  }

  public async send(message: SesMessage): Promise<string | null> {
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: formatAddress(this.config.fromEmail ?? '', this.config.fromName),
        Destination: { ToAddresses: [formatAddress(message.to, message.recipientName)] },
        ...(this.config.replyTo !== null ? { ReplyToAddresses: [this.config.replyTo] } : {}),
        ...(this.config.configurationSet !== null
          ? { ConfigurationSetName: this.config.configurationSet }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              ...(message.html !== undefined ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
              ...(message.text !== undefined ? { Text: { Data: message.text, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      }),
    );
    return result.MessageId ?? null;
  }
}
