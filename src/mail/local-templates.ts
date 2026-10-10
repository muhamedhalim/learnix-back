import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Only http(s) links are ever rendered into an email, so a bad value cannot become a script URL. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Repo-local bilingual template for the account-setup invitation (sent to approved marketplace
 * instructors). Replaces the remote MailerSend template, so the content lives in version control.
 * Returns null when the data needed to build a working link is missing.
 */
export function renderInvitationEmail(
  recipientName: string | undefined,
  locale: PreferredLanguage,
  personalization: Record<string, unknown> | undefined,
): RenderedEmail | null {
  const setupUrl = safeUrl(personalization?.['setupUrl']);
  if (setupUrl === null) return null;

  const arabic = locale === PreferredLanguage.AR;
  const name = recipientName?.trim() ?? '';
  const rawExpiry = personalization?.['expiresAt'];
  const expiry = typeof rawExpiry === 'string' && !Number.isNaN(Date.parse(rawExpiry))
    ? new Date(rawExpiry)
    : null;
  const expiryText =
    expiry === null
      ? ''
      : arabic
        ? `تنتهي صلاحية الرابط في ${expiry.toISOString().slice(0, 16).replace('T', ' ')} (UTC).`
        : `This link expires on ${expiry.toISOString().slice(0, 16).replace('T', ' ')} (UTC).`;

  const subject = arabic ? 'لديك دعوة إلى Learnix' : 'You are invited to Learnix';
  const greeting = name === '' ? (arabic ? 'مرحباً' : 'Hello') : `${arabic ? 'مرحباً' : 'Hello'} ${name}`;
  const intro = arabic
    ? 'تمت الموافقة على طلبك. اضغط على الرابط التالي لتعيين كلمة المرور وإكمال إعداد حسابك:'
    : 'Your application was approved. Use the link below to choose a password and finish setting up your account:';
  const label = arabic ? 'إعداد الحساب' : 'Set up your account';

  const text = [`${greeting},`, '', intro, setupUrl, '', expiryText].filter((l) => l !== undefined).join('\n');
  const html =
    `<div dir="${arabic ? 'rtl' : 'ltr'}" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#1f2937">` +
    `<h2>${escapeHtml(subject)}</h2><p>${escapeHtml(greeting)},</p><p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(setupUrl)}">${escapeHtml(label)}</a></p>` +
    (expiryText === '' ? '' : `<p>${escapeHtml(expiryText)}</p>`) +
    '</div>';
  return { subject, text, html };
}
