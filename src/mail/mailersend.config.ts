import type { EnvReader } from '../common/utils/redis-connection.util';

export const MAILERSEND_TEMPLATE_ENV = {
  welcome: 'MAILERSEND_TEMPLATE_WELCOME',
  passwordReset: 'MAILERSEND_TEMPLATE_PASSWORD_RESET',
  verification: 'MAILERSEND_TEMPLATE_LOGIN_VERIFICATION',
  invitation: 'MAILERSEND_TEMPLATE_INVITATION',
  paymentConfirmation: 'MAILERSEND_TEMPLATE_PAYMENT_CONFIRMATION',
  invoice: 'MAILERSEND_TEMPLATE_INVOICE',
  certificate: 'MAILERSEND_TEMPLATE_CERTIFICATE',
  homework: 'MAILERSEND_TEMPLATE_HOMEWORK',
  exam: 'MAILERSEND_TEMPLATE_EXAM',
  subscription: 'MAILERSEND_TEMPLATE_SUBSCRIPTION',
} as const;

export type MailTemplateName = keyof typeof MAILERSEND_TEMPLATE_ENV;
export type MailerSendRuntimeState =
  | 'disabled'
  | 'misconfigured'
  | 'configured'
  | 'authentication_failed'
  | 'provider_unavailable'
  | 'rate_limited';

export interface ResolvedMailerSendConfig {
  state: 'disabled' | 'misconfigured' | 'configured';
  enabled: boolean;
  configured: boolean;
  missing: string[];
  apiKey: string | null;
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  templateIds: Partial<Record<MailTemplateName, string>>;
}

function value(get: EnvReader, key: string): string | null {
  const resolved = get(key)?.trim();
  return resolved === undefined || resolved === '' ? null : resolved;
}

/** Single source of truth shared by delivery and health reporting. */
export function resolveMailerSendConfig(get: EnvReader): ResolvedMailerSendConfig {
  const enabled = value(get, 'MAIL_PROVIDER')?.toLowerCase() === 'mailersend';
  const apiKey = value(get, 'MAILERSEND_API_KEY');
  const fromEmail = value(get, 'MAIL_FROM_EMAIL');
  const fromName = value(get, 'MAIL_FROM_NAME');
  const replyTo = value(get, 'MAIL_REPLY_TO');
  const templateIds: Partial<Record<MailTemplateName, string>> = {};
  for (const [name, envKey] of Object.entries(MAILERSEND_TEMPLATE_ENV) as Array<
    [MailTemplateName, string]
  >) {
    const templateId = value(get, envKey);
    if (templateId !== null) templateIds[name] = templateId;
  }
  if (!enabled) {
    return {
      state: 'disabled',
      enabled: false,
      configured: false,
      missing: [],
      apiKey: null,
      fromEmail: null,
      fromName: null,
      replyTo: null,
      templateIds,
    };
  }
  const missing = [
    ...(apiKey === null ? ['MAILERSEND_API_KEY'] : []),
    ...(fromEmail === null ? ['MAIL_FROM_EMAIL'] : []),
    ...(fromName === null ? ['MAIL_FROM_NAME'] : []),
  ];
  return {
    state: missing.length === 0 ? 'configured' : 'misconfigured',
    enabled: true,
    configured: missing.length === 0,
    missing,
    apiKey,
    fromEmail,
    fromName,
    replyTo,
    templateIds,
  };
}

export function classifyMailerSendError(
  error: unknown,
): Exclude<MailerSendRuntimeState, 'disabled' | 'misconfigured' | 'configured'> {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const nested =
    typeof record['response'] === 'object' && record['response'] !== null
      ? (record['response'] as Record<string, unknown>)
      : {};
  const status = Number(record['statusCode'] ?? nested['status'] ?? 0);
  if (status === 401 || status === 403) return 'authentication_failed';
  if (status === 429) return 'rate_limited';
  return 'provider_unavailable';
}
