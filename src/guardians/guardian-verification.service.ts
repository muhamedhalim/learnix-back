import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'node:crypto';
import { IsNull, LessThan, MoreThan, Repository } from 'typeorm';

import { maskPhone } from '../common/utils/mask.util';
import { GuardianVerificationRequestedEvent } from './events/guardian-verification-requested.event';
import { Guardian, GuardianVerification, GuardianVerificationStatus } from './entities';
import { GuardiansService } from './guardians.service';

/** Codes live for 10 minutes. */
const CODE_TTL_MS = 10 * 60 * 1000;
/** A new code may not be requested more often than this. */
const RESEND_COOLDOWN_MS = 60 * 1000;
/** Wrong-code guesses tolerated per challenge before it is burned. */
const MAX_ATTEMPTS = 5;
/** Challenges a single guardian may request per hour. */
const MAX_CHALLENGES_PER_HOUR = 5;

/** 429 — `@nestjs/common` ships no dedicated exception for this status. */
class TooManyRequestsException extends HttpException {
  public constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class GuardianVerificationService {
  private readonly logger = new Logger(GuardianVerificationService.name);

  constructor(
    @InjectRepository(GuardianVerification)
    private readonly verifications: Repository<GuardianVerification>,
    @InjectRepository(Guardian)
    private readonly guardians: Repository<Guardian>,
    private readonly guardiansService: GuardiansService,
    private readonly events: EventEmitter2,
  ) {}

  /** Uniform 6-digit code from a CSPRNG (no modulo bias). */
  private generateCode(): string {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  }

  private hash(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  /**
   * Issue an OTP for a guardian linked to `studentId`.
   *
   * The link is checked first: a student can only ever trigger a challenge for
   * their *own* guardian, so this endpoint cannot be used to spam an arbitrary
   * phone number.
   */
  public async requestCode(studentId: string, guardianId: string): Promise<{ expires_at: Date }> {
    const link = await this.guardiansService.getLinkOrThrow(studentId, guardianId);
    const guardian = link.guardian;

    if (guardian.verification_status === GuardianVerificationStatus.VERIFIED) {
      throw new BadRequestException('This guardian is already verified');
    }

    await this.assertNotRateLimited(guardianId);

    const code = this.generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    // Burn any outstanding challenge so only the newest code is redeemable.
    await this.verifications.update(
      { guardian_id: guardianId, consumed_at: IsNull() },
      { consumed_at: new Date() },
    );

    await this.verifications.save(
      this.verifications.create({
        guardian_id: guardianId,
        code_hash: this.hash(code),
        expires_at: expiresAt,
        requested_by: studentId,
        attempts: 0,
      }),
    );

    await this.guardians.update(guardianId, {
      verification_status: GuardianVerificationStatus.PENDING,
    });

    // Emitting (rather than sending) keeps this module free of any channel
    // dependency and routes the code through the same reliable queue as every
    // other parent message.
    this.events.emit(
      GuardianVerificationRequestedEvent.NAME,
      new GuardianVerificationRequestedEvent(
        guardianId,
        studentId,
        guardian.phone_e164,
        code,
        guardian.preferred_language,
        expiresAt,
      ),
    );

    this.logger.log(
      `OTP issued for guardian ${guardianId} (${maskPhone(guardian.phone_e164) ?? '***'})`,
    );
    return { expires_at: expiresAt };
  }

  private async assertNotRateLimited(guardianId: string): Promise<void> {
    const newest = await this.verifications.findOne({
      where: { guardian_id: guardianId },
      order: { created_at: 'DESC' },
    });

    if (newest && Date.now() - newest.created_at.getTime() < RESEND_COOLDOWN_MS) {
      throw new TooManyRequestsException(
        'Please wait a minute before requesting another verification code',
      );
    }

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.verifications.count({
      where: { guardian_id: guardianId, created_at: MoreThan(oneHourAgo) },
    });
    if (recent >= MAX_CHALLENGES_PER_HOUR) {
      throw new TooManyRequestsException(
        'Too many verification attempts. Please try again in an hour.',
      );
    }
  }

  /**
   * Redeem a code. Compares in constant time and consumes the challenge on both
   * success and exhaustion, so a burned code can never be replayed.
   */
  public async verifyCode(
    studentId: string,
    guardianId: string,
    code: string,
  ): Promise<{ verified: true }> {
    await this.guardiansService.getLinkOrThrow(studentId, guardianId);

    const challenge = await this.verifications.findOne({
      where: {
        guardian_id: guardianId,
        consumed_at: IsNull(),
        expires_at: MoreThan(new Date()),
      },
      order: { created_at: 'DESC' },
    });

    if (!challenge) {
      throw new BadRequestException('No active verification code. Please request a new one.');
    }

    if (challenge.attempts >= MAX_ATTEMPTS) {
      await this.verifications.update(challenge.id, { consumed_at: new Date() });
      throw new BadRequestException('Too many incorrect attempts. Please request a new code.');
    }

    if (!this.matches(code, challenge.code_hash)) {
      await this.verifications.increment({ id: challenge.id }, 'attempts', 1);
      throw new BadRequestException('Incorrect verification code');
    }

    const now = new Date();
    await this.verifications.update(challenge.id, { consumed_at: now });
    await this.guardians.update(guardianId, {
      verification_status: GuardianVerificationStatus.VERIFIED,
      verified_at: now,
    });

    this.logger.log(`Guardian ${guardianId} verified`);
    return { verified: true };
  }

  /** Constant-time comparison of the SHA-256 digests. */
  private matches(candidate: string, expectedHash: string): boolean {
    const candidateHash = Buffer.from(this.hash(candidate), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    if (candidateHash.length !== expected.length) return false;
    return crypto.timingSafeEqual(candidateHash, expected);
  }

  /** Housekeeping: drop challenges that expired more than a day ago. */
  public async purgeExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.verifications.delete({ expires_at: LessThan(cutoff) });
    return result.affected ?? 0;
  }
}
