import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DEF-005 guard rail: the notification-preference gate must never reach
 * transactional or security mail.
 *
 * The dangerous failure mode of this change is not "email_enabled does not
 * work" — it is "email_enabled works too well" and a user who switches
 * notification email off can no longer receive a password-reset link, a login
 * verification code, or an invoice. That is a lockout, and it would be
 * introduced by a single plausible-looking refactor that routes one more
 * `MailService` call through `NotificationEmailService`.
 *
 * These assertions are structural on purpose: they fail the moment such a
 * refactor is written, rather than the moment a user is locked out.
 */

const SRC = join(__dirname, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(SRC, ...parts), 'utf8');
}

describe('optional-notification vs transactional mail boundary', () => {
  it('password reset uses MailService directly and never the preference gate', () => {
    const auth = read('auth', 'auth.service.ts');

    expect(auth).toContain('this.mailService.sendPasswordResetEmail(');
    expect(auth).not.toContain('NotificationEmailService');
    expect(auth).not.toContain('NotificationChannelPolicyService');
  });

  it('operational alerts to administrators are never suppressible by a user preference', () => {
    const alerts = read('health', 'operational-alert.service.ts');

    expect(alerts).not.toContain('NotificationEmailService');
    expect(alerts).not.toContain('NotificationChannelPolicyService');
  });

  it('MailService itself knows nothing about notification preferences', () => {
    const mail = read('mail', 'mail.service.ts');

    // The transport must stay a transport. If the gate ever moves inside it,
    // every transactional template inherits the gate silently.
    expect(mail).not.toContain('NotificationChannelPolicyService');
    expect(mail).not.toContain('notification_settings');
    expect(mail).not.toContain('email_enabled');
  });

  it('the gate is applied only at enumerated optional-notification call sites', () => {
    // Lesson-session lifecycle mail is currently the ONLY optional notification
    // email in the product. Adding another is fine — updating this list is the
    // point, because it forces the "is this optional or transactional?"
    // question to be answered deliberately.
    const lessonSessions = read('lessons', 'lesson-sessions.service.ts');

    expect(lessonSessions).toContain('NotificationEmailService');
    expect(lessonSessions).toContain('this.notificationEmail.send(');
    // …and it no longer bypasses the gate by calling the transport directly.
    expect(lessonSessions).not.toContain('this.mailService.send(');
  });

  it('the email gate consults the channel policy before touching the provider', () => {
    const service = read('notifications', 'services', 'notification-email.service.ts');

    const decideAt = service.indexOf('this.policy.decide(');
    const sendAt = service.indexOf('this.mail.send(');
    expect(decideAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(decideAt).toBeLessThan(sendAt);
  });
});
