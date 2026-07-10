import type { PreferredLanguage } from '../entities';

/** Emitted when an OTP challenge has been persisted and needs delivering. */
export class GuardianVerificationRequestedEvent {
  public static readonly NAME = 'guardian.verification.requested';

  constructor(
    public readonly guardianId: string,
    public readonly studentId: string,
    public readonly phoneE164: string,
    /**
     * Plaintext OTP. Only ever lives in-process and in the BullMQ job payload
     * (Redis) for the seconds before delivery — the database stores a hash. It
     * is deliberately excluded from every log line.
     */
    public readonly code: string,
    public readonly language: PreferredLanguage,
    public readonly expiresAt: Date,
  ) {}
}
