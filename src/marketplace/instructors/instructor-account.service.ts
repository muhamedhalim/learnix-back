import * as crypto from 'node:crypto';

import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';
import { EntityManager, Repository } from 'typeorm';

import { durationToMilliseconds } from '../../common/utils/duration.util';
import { buildAbsoluteUrl, getConfiguredPublicOrigin } from '../../config/public-url.util';
import { PreferredLanguage } from '../../guardians/entities/preferred-language.enum';
import { biBody } from '../../i18n/error-translator.util';
import { MailService } from '../../mail/mail.service';
import { User } from '../../users/entities/user.entity';
import { UserStatus } from '../../users/entities/user-status.enum';
import { slugify } from '../common/utils/slugify.util';
import type { InstructorApplication } from './entities';

/** `slugify` already appends 3 random bytes, so a handful of attempts is ample. */
const MAX_USERNAME_ATTEMPTS = 3;

/**
 * Provisions the platform identity behind an approved **public** instructor
 * application — one submitted by someone who had no account at all.
 *
 * This exists so that becoming an instructor never requires first registering
 * into the academic student or teacher lifecycle. It deliberately does not
 * call `AuthService.register`: that method requests an *academic* account and
 * always creates it `PENDING` for academic admin approval, which is precisely
 * the coupling this flow must avoid. The account created here instead carries:
 *
 * - `role = null` — no academic role at all, so every academic role check,
 *   list and report excludes it by construction (see `User.role`);
 * - `status = APPROVED` — the admin's approval of the application *is* the
 *   account approval; there is no second, academic review;
 * - `password_hash = null` — the applicant sets their own password through the
 *   existing reset-password flow via the emailed setup link.
 *
 * Instructor authority is never stored on the user: it lives in
 * `marketplace_instructors`, created by `InstructorService.approveApplication`
 * in the same transaction as this provisioning. The dependency arrow points
 * marketplace → platform only, so `MARKETPLACE_ENABLED=false` still removes
 * the feature cleanly.
 */
@Injectable()
export class InstructorAccountService {
  private readonly logger = new Logger(InstructorAccountService.name);
  private readonly bcryptRounds: number;

  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {
    this.bcryptRounds = this.configService.get<number>('BCRYPT_ROUNDS') ?? 12;
  }

  /**
   * Whether these contact details already belong to a platform account.
   *
   * A public application must not create a second identity for someone who
   * can already sign in — they are asked to sign in and apply instead, which
   * keeps one person to one account.
   */
  public async findByEmailOrPhone(email: string, phone: string): Promise<User | null> {
    return this.users.findOne({ where: [{ email }, { phone }] });
  }

  /**
   * Resolves the application's applicant to a platform identity, creating one
   * when needed. Takes the approval transaction's `manager` so an account is
   * never left behind by an approval that later fails.
   *
   * If an account already carries the applicant's email — they registered
   * between submitting and being approved — that account is linked rather than
   * duplicated, which is also what makes a retried approval safe.
   */
  public async resolveOrCreateAccount(
    manager: EntityManager,
    application: InstructorApplication,
  ): Promise<{ user: User; created: boolean }> {
    const email = application.applicant_email?.trim().toLowerCase();
    if (email === undefined || email === '') {
      throw new ConflictException(
        biBody(
          'This application has neither an applicant account nor a contact email',
          'هذا الطلب لا يحتوي على حساب مقدّم الطلب ولا بريد إلكتروني للتواصل',
        ),
      );
    }

    const users = manager.getRepository(User);

    const existing = await users.findOne({ where: { email } });
    if (existing !== null) {
      return { user: existing, created: false };
    }

    const phone = application.applicant_phone?.trim();
    if (phone === undefined || phone === '') {
      throw new ConflictException(
        biBody(
          'This application has no contact phone number to create an account with',
          'هذا الطلب لا يحتوي على رقم هاتف للتواصل لإنشاء حساب به',
        ),
      );
    }

    // `users.phone` is unique: a clash means the number already belongs to
    // someone else, which a human has to resolve — never silently reuse or
    // overwrite another person's account.
    const phoneOwner = await users.findOne({ where: { phone } });
    if (phoneOwner !== null) {
      throw new ConflictException(
        biBody(
          'That phone number already belongs to another account',
          'رقم الهاتف هذا مرتبط بحساب آخر بالفعل',
        ),
      );
    }

    const user = await this.insertWithUniqueUsername(users, application, email, phone);
    this.logger.log(
      `Provisioned marketplace-only account ${user.id} for application ${application.id}`,
    );
    return { user, created: true };
  }

  /**
   * Issues a single-use password-setup token and emails the link.
   *
   * It writes the same three `password_reset_*` columns the forgot-password
   * flow uses, so the existing `POST /auth/reset-password` endpoint and
   * `/auth/reset-password` page accept it unchanged: a first-time setup and a
   * reset are the same operation against an account whose `password_hash` is
   * null. Called only after the approval transaction has committed — a failed
   * email must never roll back a granted capability.
   */
  public async sendAccountSetupLink(user: User): Promise<boolean> {
    try {
      return await this.issueAndSendSetupLink(user);
    } catch (error) {
      // The approval has already committed and must never be reported as failed because an email could
      // not be queued. The caller learns the outcome and the administrator can resend.
      this.logger.error(
        `Account setup link for ${user.id} could not be sent: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return false;
    }
  }

  /**
   * Re-sends the setup link to an account that still has no password. A fresh token replaces the old one.
   *
   * This exists because "Forgot password" cannot help such an account: it deliberately ignores accounts
   * without a password hash, so an instructor whose first email never arrived would otherwise be locked
   * out with no way back in.
   */
  public async resendSetupLink(
    userId: string,
  ): Promise<'sent' | 'failed' | 'has_password' | 'not_found'> {
    const user = await this.users
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.id = :userId', { userId })
      .getOne();
    if (user === null) return 'not_found';
    if (user.password_hash !== null && user.password_hash !== '') return 'has_password';
    return (await this.sendAccountSetupLink(user)) ? 'sent' : 'failed';
  }

  private async issueAndSendSetupLink(user: User): Promise<boolean> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenId = crypto.createHash('sha256').update(rawToken).digest('hex');
    const hashedToken = await bcrypt.hash(rawToken, this.bcryptRounds);

    const configured = this.configService.get<string>('INSTRUCTOR_SETUP_EXPIRATION') ?? '7d';
    const ms = durationToMilliseconds(configured) ?? durationToMilliseconds('7d');
    const expiresAt = new Date(Date.now() + (ms ?? 0));

    await this.users.update(user.id, {
      password_reset_token: hashedToken,
      password_reset_token_id: tokenId,
      password_reset_expires_at: expiresAt,
    });

    const frontendUrl = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const setupUrl = `${buildAbsoluteUrl(frontendUrl, '/auth/reset-password')}?token=${rawToken}`;

    // `false` means the mail provider is not configured or no durable job could be created.
    const queued = await this.mailService.sendInvitationEmail({
      to: user.email,
      recipientName: user.name,
      locale: user.preferred_language ?? PreferredLanguage.EN,
      personalization: { setupUrl, expiresAt: expiresAt.toISOString() },
    });
    if (!queued) {
      this.logger.warn(`Account setup link for instructor account ${user.id} was not queued`);
      return false;
    }

    this.logger.log(`Account setup link issued for instructor account ${user.id}`);
    return true;
  }

  private async insertWithUniqueUsername(
    users: Repository<User>,
    application: InstructorApplication,
    email: string,
    phone: string,
  ): Promise<User> {
    for (let attempt = 1; attempt <= MAX_USERNAME_ATTEMPTS; attempt += 1) {
      const username = slugify(application.display_name, 'instructor');
      if ((await users.findOne({ where: { username } })) !== null) continue;

      return users.save(
        users.create({
          username,
          name: application.display_name,
          email,
          phone,
          password_hash: null,
          role: null,
          status: UserStatus.APPROVED,
          is_active: true,
        }),
      );
    }

    throw new ConflictException(
      biBody('Could not allocate a unique username', 'تعذّر إنشاء اسم مستخدم فريد'),
    );
  }
}
