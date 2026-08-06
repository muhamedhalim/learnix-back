import {
  applyStagingSubjectPrefix,
  evaluateMailRecipient,
  evaluatePhoneRecipient,
} from './staging-messaging-guard.util';

function reader(values: Record<string, string | undefined>): (key: string) => string | undefined {
  return (key) => values[key];
}

describe('staging-messaging-guard.util', () => {
  describe('evaluateMailRecipient', () => {
    it('is inert (never blocks) when APP_ENV is not staging', () => {
      const get = reader({ APP_ENV: 'production', MAIL_ALLOWLIST: 'allowed@example.com' });
      expect(evaluateMailRecipient(get, 'anyone@else.com')).toEqual({ blocked: false });
    });

    it('is inert when APP_ENV is unset (defaults away from staging)', () => {
      const get = reader({ MAIL_ALLOWLIST: 'allowed@example.com' });
      expect(evaluateMailRecipient(get, 'anyone@else.com')).toEqual({ blocked: false });
    });

    it('allows an exact address match on staging', () => {
      const get = reader({ APP_ENV: 'staging', MAIL_ALLOWLIST: 'tester@example.com' });
      expect(evaluateMailRecipient(get, 'tester@example.com').blocked).toBe(false);
    });

    it('allows any address under an allowlisted domain', () => {
      const get = reader({ APP_ENV: 'staging', MAIL_ALLOWLIST: 'example.com' });
      expect(evaluateMailRecipient(get, 'someone@example.com').blocked).toBe(false);
    });

    it('blocks a recipient not on the allowlist, with a reason and no raw address', () => {
      const get = reader({ APP_ENV: 'staging', MAIL_ALLOWLIST: 'tester@example.com' });
      const decision = evaluateMailRecipient(get, 'real.student@gmail.com');
      expect(decision.blocked).toBe(true);
      expect(decision.reason).toBeDefined();
      expect(decision.reason).not.toContain('real.student@gmail.com');
    });

    it('blocks every recipient when the allowlist is empty or unset', () => {
      const get = reader({ APP_ENV: 'staging' });
      expect(evaluateMailRecipient(get, 'anyone@example.com').blocked).toBe(true);
    });

    it('matches case-insensitively', () => {
      const get = reader({ APP_ENV: 'staging', MAIL_ALLOWLIST: 'Tester@Example.com' });
      expect(evaluateMailRecipient(get, 'tester@example.com').blocked).toBe(false);
    });
  });

  describe('applyStagingSubjectPrefix', () => {
    it('leaves the subject unchanged outside staging', () => {
      const get = reader({ APP_ENV: 'production' });
      expect(applyStagingSubjectPrefix(get, 'Welcome')).toBe('Welcome');
    });

    it('prefixes the subject on staging', () => {
      const get = reader({ APP_ENV: 'staging' });
      expect(applyStagingSubjectPrefix(get, 'Welcome')).toBe('[STAGING] Welcome');
    });

    it('does not double-prefix an already-prefixed subject', () => {
      const get = reader({ APP_ENV: 'staging' });
      expect(applyStagingSubjectPrefix(get, '[STAGING] Welcome')).toBe('[STAGING] Welcome');
    });
  });

  describe('evaluatePhoneRecipient', () => {
    it('is inert when APP_ENV is not staging', () => {
      const get = reader({ APP_ENV: 'production', SMS_ALLOWLIST: '+201000000001' });
      expect(evaluatePhoneRecipient(get, '+201234567890').blocked).toBe(false);
    });

    it('allows an allowlisted number on staging', () => {
      const get = reader({ APP_ENV: 'staging', SMS_ALLOWLIST: '+201000000001,+201000000002' });
      expect(evaluatePhoneRecipient(get, '+201000000002').blocked).toBe(false);
    });

    it('blocks a non-allowlisted number on staging, with a masked reason', () => {
      const get = reader({ APP_ENV: 'staging', SMS_ALLOWLIST: '+201000000001' });
      const decision = evaluatePhoneRecipient(get, '+201234567890');
      expect(decision.blocked).toBe(true);
      expect(decision.reason).not.toContain('+201234567890');
    });

    it('blocks every number when the allowlist is unset', () => {
      const get = reader({ APP_ENV: 'staging' });
      expect(evaluatePhoneRecipient(get, '+201234567890').blocked).toBe(true);
    });
  });
});
