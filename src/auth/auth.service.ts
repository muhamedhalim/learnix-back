import * as crypto from 'node:crypto';

import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { parseDuration } from '../common/utils/duration.util';
import { InvalidPhoneNumberError, toE164 } from '../common/utils/phone.util';
import { buildAbsoluteUrl, getConfiguredPublicOrigin } from '../config/public-url.util';
import { biBody } from '../i18n/error-translator.util';
import { GuardianRelationship } from '../guardians/entities';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { GuardiansService } from '../guardians/guardians.service';
import { MailService } from '../mail/mail.service';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserSession } from '../users/entities/user-session.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { SessionsService } from '../users/sessions.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

/** Postgres SQLSTATE for `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * The auto-generated username is the only unique column on `users` that the
 * caller does not supply, so a collision there is ours to retry rather than a
 * conflict to report. Three attempts against a 3-byte random suffix leaves a
 * residual failure probability far below any other cause of a failed insert.
 */
const MAX_USERNAME_ATTEMPTS = 3;

interface PostgresDriverError {
  code?: unknown;
  detail?: unknown;
  constraint?: unknown;
}

/** Everything `register` needs to write one PENDING account, already normalized. */
interface PendingAccountInput {
  email: string;
  phone: string;
  name: string;
  passwordHash: string;
  requestedRole: UserRole;
  preferredLanguage: PreferredLanguage;
  /** Canonical E.164, for a student request; `null` for a teacher request. */
  parentPhoneE164: string | null;
  qualifications: string | null;
  yearsOfExperience: number | null;
  bio: string | null;
}

/**
 * Column names carried by a Postgres `unique_violation`, parsed out of its
 * `Key (email)=(a@b.test) already exists.` detail string. Returns `null` for
 * anything that is not a 23505 so callers rethrow what they did not expect,
 * and an empty array when the driver withheld the detail. Callers must only
 * suppress conflicts that this detail proves belong to caller-supplied user
 * identifiers; an unattributable/internal conflict is a real persistence
 * failure and must not be reported as a successful registration.
 */
function uniqueViolationColumns(error: unknown): string[] | null {
  for (const candidate of [error, (error as { driverError?: unknown } | null)?.driverError]) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { code, detail, constraint } = candidate as PostgresDriverError;
    if (code !== PG_UNIQUE_VIOLATION) continue;

    const key = typeof detail === 'string' ? /^Key \(([^)]+)\)=/.exec(detail)?.[1] : undefined;
    if (key !== undefined) {
      return key.split(',').map((column) => column.trim().replaceAll('"', ''));
    }
    return typeof constraint === 'string' ? [constraint] : [];
  }
  return null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds: number;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessionsService: SessionsService,
    private readonly mailService: MailService,
    private readonly guardiansService: GuardiansService,
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.bcryptRounds = this.configService.get<number>('BCRYPT_ROUNDS') ?? 12;
  }

  /**
   * Registers an application for either a STUDENT or a TEACHER account.
   *
   * `requestedRole` is exactly that — a request, not a grant. Every account is
   * created with `status = PENDING` regardless of which role was requested,
   * and cannot log in until an admin approves it via the existing
   * `admin/students` or `admin/teachers` approval endpoints (StudentsService /
   * TeachersService `approve*`/`reject*` — unchanged by this method). Those
   * endpoints already expect a profile to exist ahead of approval, so the
   * user row and its role-specific profile (+ guardian link, for students)
   * are created together, atomically, right here — mirroring the pattern
   * already used by the bulk student importer
   * (`BulkOperationsService.saveImportedStudent`), which creates User +
   * StudentProfile (+ guardian via `linkGuardianWith`) in one transaction for
   * the same reason: a mid-way failure must never leave an orphaned user with
   * no profile or a student with no guardian.
   *
   * Anti-enumeration contract — the reason this method returns a bare
   * acknowledgement and nothing else. An unauthenticated caller must not be
   * able to learn whether an email or phone is registered, so *every* outcome
   * below produces the byte-identical `202 Accepted` body:
   *
   *  - a brand-new request that created a PENDING account;
   *  - an email, phone, or parent phone that already belongs to someone;
   *  - a still-pending request for the same identifiers;
   *  - a request that lost a unique-constraint race to a simultaneous one.
   *
   * No `userId`, no `emailExists`/`phoneExists`, no conflict reason, no
   * account status — nothing that distinguishes "created" from "already
   * there". The previous `409 Conflict` + `201 { userId }` pair was a
   * two-value oracle over the whole user table.
   *
   * Latency is part of the contract too: the bcrypt hash (~250ms at 12 rounds)
   * is computed *before* the existence lookup so both paths pay the same
   * dominant cost, and a stopwatch cannot substitute for the response body.
   *
   * Malformed input is deliberately still a 400 — a rejected phone format or
   * a missing field says nothing about who is registered. Only
   * existence-related conflicts are hidden.
   */
  public async register(
    registerDto: RegisterDto,
    preferredLanguage: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<{ message: string; message_ar: string }> {
    const { password, name, requestedRole, qualifications, yearsOfExperience, bio } = registerDto;

    const acknowledgement = biBody(
      'Registration request received. Pending approval',
      'تم استلام طلب التسجيل. بانتظار الموافقة',
    );

    // Normalized identically to login()/forgotPassword()/AdminInitializationService
    // so every entry point that writes or queries `email` agrees on its casing —
    // and so `Ali@X.com` cannot slip past the uniqueness check that `ali@x.com`
    // would fail. `phone` is already digit-only per RegisterDto's @Matches.
    const email = registerDto.email.trim().toLowerCase();
    const phone = registerDto.phone.trim();

    // Canonicalise the guardian number here rather than letting
    // `linkGuardianWith` raise the same 400 from inside the transaction, after
    // a user row has been written and must be rolled back.
    const parentPhoneE164 =
      requestedRole === UserRole.STUDENT ? toE164(registerDto.parentPhone ?? '') : null;
    if (requestedRole === UserRole.STUDENT && parentPhoneE164 === null) {
      throw new BadRequestException(new InvalidPhoneNumberError().message);
    }

    // Hashed before the lookup, not after — see the docstring's latency note.
    const passwordHash = await bcrypt.hash(password, this.bcryptRounds);

    const existingUser = await this.userRepository.findOne({
      where: [{ email }, { phone }],
    });

    if (existingUser) {
      // Logged without the identifier: the log must not become the oracle the
      // response no longer is.
      this.logger.log('Registration request for an already-registered identifier — not created');
      return acknowledgement;
    }

    const createdUserId = await this.createPendingAccount({
      email,
      phone,
      name: name.trim(),
      passwordHash,
      requestedRole,
      preferredLanguage,
      parentPhoneE164,
      qualifications: qualifications ?? null,
      yearsOfExperience: yearsOfExperience ?? null,
      bio: bio ?? null,
    });

    if (createdUserId === false) {
      this.logger.log('Registration lost a unique-constraint race — acknowledged generically');
    } else if (requestedRole === UserRole.TEACHER) {
      // A student's own PENDING status is routine account housekeeping; a
      // request for the teacher role is the one registration outcome an
      // admin needs to act on, so it is the only one that reaches the admin
      // notification catalog (see `AdminAlertsListener`).
      this.eventEmitter.emit('teacher.registration_pending', {
        userId: createdUserId,
        name: name.trim(),
        email,
      });
    }

    return acknowledgement;
  }

  /**
   * Write one PENDING account atomically. Returns the new user's id, or
   * `false` when a caller-supplied identifier lost a race against a
   * simultaneous request (the DB unique constraints are the authority, not
   * the `findOne` above, which two concurrent registrations can both pass).
   * Retries only when the *generated* username collides, which is not the
   * caller's conflict.
   */
  private async createPendingAccount(input: PendingAccountInput): Promise<string | false> {
    let lastUsernameCollision: unknown;

    for (let attempt = 0; attempt < MAX_USERNAME_ATTEMPTS; attempt++) {
      try {
        let createdUserId = '';
        await this.dataSource.transaction(async (manager) => {
          createdUserId = await this.persistPendingAccount(manager, input);
        });
        return createdUserId;
      } catch (error) {
        const columns = uniqueViolationColumns(error);
        if (columns === null) throw error;
        if (columns.includes('username') || columns.includes('UQ_users_username')) {
          lastUsernameCollision = error;
          continue;
        }
        if (
          columns.includes('email') ||
          columns.includes('phone') ||
          columns.includes('UQ_users_email') ||
          columns.includes('UQ_users_phone')
        ) {
          return false;
        }

        // `phone_e164`, student/profile/link constraints, and unattributable
        // 23505s are internal persistence failures. A guardian-phone race is
        // recovered atomically in GuardiansService; swallowing one here would
        // roll back the account while returning a false success acknowledgement.
        throw error;
      }
    }

    throw lastUsernameCollision;
  }

  /**
   * The user row + its role-specific profile (+ guardian link, for
   * students). Returns the new user's id.
   */
  private async persistPendingAccount(
    manager: EntityManager,
    input: PendingAccountInput,
  ): Promise<string> {
    const user = manager.create(User, {
      username: this.generateUsername(input.email),
      name: input.name,
      email: input.email,
      phone: input.phone,
      password_hash: input.passwordHash,
      role: input.requestedRole,
      is_active: true,
      status: UserStatus.PENDING, // Pending admin approval — see docstring above.
      preferred_language: input.preferredLanguage,
    });
    const createdUser = await manager.save(User, user);

    if (input.requestedRole === UserRole.STUDENT) {
      const profile = manager.create(StudentProfile, {
        user_id: createdUser.id,
        notification_settings: {
          sms_enabled: true,
          email_enabled: true,
          lesson_reminders: true,
          exam_results: true,
          payment_notifications: true,
        },
      });
      await manager.save(StudentProfile, profile);

      // `parentPhoneE164` is non-null for a student request — `register`
      // rejects an uncanonicalisable one with a 400 before reaching here.
      // Becomes an UNVERIFIED Guardian: captured, but unable to receive any
      // educational notification until an OTP proves the parent owns it. An
      // already-known guardian phone is *reused*, never a conflict — which is
      // why a shared parent number reveals nothing either.
      await this.guardiansService.linkGuardianWith(manager, createdUser.id, {
        phone: input.parentPhoneE164 as string,
        relationship: GuardianRelationship.OTHER,
        is_primary: true,
      });
    } else {
      const profile = manager.create(TeacherProfile, {
        user_id: createdUser.id,
        // RegisterDto guarantees these are present for a teacher request.
        qualifications: input.qualifications as string,
        years_of_experience: input.yearsOfExperience as number,
        bio: input.bio,
        rating: 0,
        total_ratings: 0,
      });
      await manager.save(TeacherProfile, profile);
    }

    return createdUser.id;
  }

  /** Email prefix + random suffix, unique enough to satisfy `users.username`. */
  private generateUsername(email: string): string {
    const emailPrefix = (email.split('@')[0] ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
    return `${emailPrefix}_${crypto.randomBytes(3).toString('hex')}`;
  }

  public async login(
    loginDto: LoginDto,
    deviceInfo: string | null = null,
    ipAddress: string | null = null,
  ): Promise<unknown> {
    const { password } = loginDto;
    // Same trim().toLowerCase() normalization as register()/forgotPassword()/
    // AdminInitializationService — required for the admin row that service
    // creates (and any user created before this normalization existed) to be
    // reliably found here regardless of casing.
    const email = loginDto.email.trim().toLowerCase();

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email })
      .getOne();

    if (!user) {
      // Do not log the raw email (PII). Enumeration protection also benefits.
      this.logger.warn('Failed login attempt for non-existent account');
      throw new UnauthorizedException(biBody('Invalid credentials', 'بيانات الاعتماد غير صحيحة'));
    }

    if (user.password_hash === null || user.password_hash === '') {
      this.logger.warn(`Failed login attempt for Firebase-only account (ID: ${user.id})`);
      throw new UnauthorizedException(
        biBody(
          'This account uses Firebase authentication. Please sign in with your Firebase provider.',
          'يستخدم هذا الحساب مصادقة Firebase. يرجى تسجيل الدخول عبر مزود Firebase.',
        ),
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      this.logger.warn(`Failed login attempt - invalid password (ID: ${user.id})`);
      throw new UnauthorizedException(biBody('Invalid credentials', 'بيانات الاعتماد غير صحيحة'));
    }

    // Check user status (BREAKING CHANGE: new response format)
    if (user.status === UserStatus.PENDING) {
      this.logger.log(`Login attempt with pending account (ID: ${user.id})`);
      return {
        status: 'pending',
        ...biBody(
          'Your account is under review. Please wait for admin approval.',
          'حسابك قيد المراجعة. يرجى انتظار موافقة الإدارة.',
        ),
      };
    }

    if (user.status === UserStatus.REJECTED) {
      this.logger.warn(`Login attempt with rejected account (ID: ${user.id})`);
      throw new UnauthorizedException(
        biBody(
          `Account rejected: ${user.rejection_reason ?? 'Please contact support for more information.'}`,
          `تم رفض الحساب: ${user.rejection_reason ?? 'يرجى التواصل مع الدعم لمزيد من المعلومات.'}`,
        ),
      );
    }

    // User is approved - generate tokens
    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    // Generate and store a per-device refresh credential.
    const refreshToken = this.generateRefreshToken();
    const tokenId = this.generateTokenId(refreshToken);
    const refreshTokenHash = await this.hashRefreshToken(refreshToken);
    const expiresAt = this.calculateTokenExpiration(
      this.configService.get<string>('JWT_REFRESH_EXPIRATION') ?? '7d',
    );

    const session = await this.sessionsService.createSession({
      userId: user.id,
      refreshTokenId: tokenId,
      refreshTokenHash,
      deviceInfo,
      ipAddress,
      expiresAt,
    });

    const accessToken = this.jwtService.sign({ ...payload, sid: session.id });

    // Return new response format with status
    return {
      status: 'approved',
      accessToken,
      refreshToken,
      role: user.role,
      userId: user.id,
    };
  }

  public async validateUser(payload: { sub: string; email: string; sid: string }): Promise<{
    userId: string;
    email: string;
    name: string;
    role: UserRole;
    sessionId: string;
  } | null> {
    if (payload.sid === '') return null;
    const session = await this.sessionsService.getActiveSession(payload.sub, payload.sid);
    const user = session?.user;

    if (
      session !== null &&
      user?.is_active === true &&
      user.status === UserStatus.APPROVED &&
      user.email === payload.email
    ) {
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        sessionId: session.id,
      };
    }
    return null;
  }

  /**
   * Generate a secure random refresh token
   */
  private generateRefreshToken(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Generate token ID for database indexing (SHA-256)
   * This is separate from bcrypt hash - used only for fast lookup
   */
  private generateTokenId(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Hash refresh token before storing in database
   */
  private async hashRefreshToken(token: string): Promise<string> {
    return await bcrypt.hash(token, this.bcryptRounds);
  }

  /**
   * Verify refresh token against stored hash
   */
  private async verifyRefreshToken(token: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(token, hash);
  }

  /**
   * Calculate token expiration date from duration string
   */
  private calculateTokenExpiration(duration: string): Date {
    const parsed = parseDuration(duration);
    if (parsed === null) {
      throw new Error(`Invalid duration format: ${duration}`);
    }

    const { value, unit } = parsed;
    const now = new Date();

    switch (unit) {
      case 'd': // days
        now.setDate(now.getDate() + value);
        break;
      case 'h': // hours
        now.setHours(now.getHours() + value);
        break;
      case 'm': // minutes
        now.setMinutes(now.getMinutes() + value);
        break;
      case 's': // seconds
        now.setSeconds(now.getSeconds() + value);
        break;
      default:
        throw new Error(`Invalid duration unit: ${unit}`);
    }

    return now;
  }

  /**
   * Refresh access token using refresh token
   * Optimized: O(1) database lookup via indexed token_id
   */
  public async refresh(refreshToken: string): Promise<unknown> {
    return await this.rotateRefreshSession(refreshToken);
  }

  private async rotateRefreshSession(refreshToken: string): Promise<unknown> {
    const tokenId = this.generateTokenId(refreshToken);
    const newRefreshToken = this.generateRefreshToken();
    const newTokenId = this.generateTokenId(newRefreshToken);
    const newRefreshTokenHash = await this.hashRefreshToken(newRefreshToken);
    const newExpiresAt = this.calculateTokenExpiration(
      this.configService.get<string>('JWT_REFRESH_EXPIRATION') ?? '7d',
    );

    const rotated = await this.dataSource.transaction(async (manager) => {
      const sessionRepository = manager.getRepository(UserSession);
      const session = await sessionRepository
        .createQueryBuilder('session')
        .addSelect('session.refresh_token_hash')
        .where('session.refresh_token_id = :tokenId', { tokenId })
        .setLock('pessimistic_write')
        .getOne();

      if (session === null) {
        this.logger.warn('Invalid, reused, or revoked refresh token attempt');
        throw new UnauthorizedException(biBody('Invalid refresh token', 'رمز التحديث غير صالح'));
      }

      const isValid = await this.verifyRefreshToken(refreshToken, session.refresh_token_hash);
      if (!isValid) {
        await sessionRepository.delete({ id: session.id });
        throw new UnauthorizedException(biBody('Invalid refresh token', 'رمز التحديث غير صالح'));
      }

      if (session.expires_at < new Date()) {
        await sessionRepository.delete({ id: session.id });
        throw new UnauthorizedException(
          biBody('Refresh token expired', 'انتهت صلاحية رمز التحديث'),
        );
      }

      // PostgreSQL cannot apply FOR UPDATE to the nullable side of the outer
      // join TypeORM creates for `leftJoinAndSelect`. Lock the session row
      // first, then fetch its required user within the same transaction.
      const user = await manager.getRepository(User).findOneBy({ id: session.user_id });
      if (user === null || !user.is_active || user.status !== UserStatus.APPROVED) {
        await sessionRepository.delete({ id: session.id });
        throw new UnauthorizedException(
          biBody('User account is inactive', 'حساب المستخدم غير نشط'),
        );
      }

      await sessionRepository.update(session.id, {
        refresh_token_id: newTokenId,
        refresh_token_hash: newRefreshTokenHash,
        last_active: new Date(),
        expires_at: newExpiresAt,
      });

      return { user, sessionId: session.id };
    });

    const accessToken = this.jwtService.sign({
      sub: rotated.user.id,
      email: rotated.user.email,
      name: rotated.user.name,
      role: rotated.user.role,
      sid: rotated.sessionId,
    });

    this.logger.log(`Token refreshed - ID: ${rotated.user.id}`);
    return {
      status: 'approved',
      accessToken,
      refreshToken: newRefreshToken,
      role: rotated.user.role,
      userId: rotated.user.id,
    };
  }

  public async forgotPassword(email: string): Promise<{ message: string; resetToken?: string }> {
    const genericMessage = biBody(
      'If an account exists for that email, a password reset link has been sent.',
      'إذا كان هناك حساب مرتبط بهذا البريد الإلكتروني، فقد تم إرسال رابط إعادة تعيين كلمة المرور.',
    );

    const normalizedEmail = email.toLowerCase().trim();

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email: normalizedEmail })
      .getOne();

    // Silently no-op for unknown, inactive, or Firebase-only accounts.
    if (!user || !user.is_active || user.password_hash === null || user.password_hash === '') {
      this.logger.log('Password reset requested for a non-eligible account');
      return genericMessage;
    }

    // Generate + store a fresh single-use token (overwrites any previous one).
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenId = this.generateTokenId(rawToken);
    const hashedToken = await bcrypt.hash(rawToken, this.bcryptRounds);
    const expiration = this.configService.get<string>('PASSWORD_RESET_EXPIRATION') ?? '1h';
    const expiresAt = this.calculateTokenExpiration(expiration);

    await this.userRepository.update(user.id, {
      password_reset_token: hashedToken,
      password_reset_token_id: tokenId,
      password_reset_expires_at: expiresAt,
    });

    const frontendUrl = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const resetUrl = `${buildAbsoluteUrl(frontendUrl, '/auth/reset-password')}?token=${rawToken}`;

    await this.mailService.sendPasswordResetEmail(
      user.email,
      user.name,
      resetUrl,
      this.humanizeDuration(expiration),
      user.preferred_language ?? PreferredLanguage.EN,
    );

    this.logger.log(`Password reset token issued for user ${user.id}`);

    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';

    return isProduction ? genericMessage : { ...genericMessage, resetToken: rawToken };
  }

  public async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const invalidTokenError = new BadRequestException(
      biBody(
        'This password reset link is invalid or has expired. Please request a new one.',
        'رابط إعادة تعيين كلمة المرور غير صالح أو منتهي الصلاحية. يرجى طلب رابط جديد.',
      ),
    );

    const tokenId = this.generateTokenId(token);

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password_reset_token')
      .where('user.password_reset_token_id = :tokenId', { tokenId })
      .andWhere('user.password_reset_token IS NOT NULL')
      .getOne();

    if (user?.password_reset_token == null) {
      throw invalidTokenError;
    }

    const isValid = await bcrypt.compare(token, user.password_reset_token);
    if (!isValid) {
      this.logger.warn(`Password reset token mismatch for user ${user.id}`);
      throw invalidTokenError;
    }

    if (!user.password_reset_expires_at || user.password_reset_expires_at < new Date()) {
      this.logger.warn(`Expired password reset token used for user ${user.id}`);
      // Consume the stale token so it cannot be retried.
      await this.userRepository.update(user.id, {
        password_reset_token: null,
        password_reset_token_id: null,
        password_reset_expires_at: null,
      });
      throw invalidTokenError;
    }

    const hashedPassword = await bcrypt.hash(newPassword, this.bcryptRounds);

    // Set new password, consume the reset token, and revoke refresh credentials.
    await this.userRepository.update(user.id, {
      password_hash: hashedPassword,
      password_reset_token: null,
      password_reset_token_id: null,
      password_reset_expires_at: null,
    });

    // Drop all device sessions — force re-login everywhere after a reset.
    await this.sessionsService.deleteAllUserSessions(user.id);

    this.logger.log(`Password reset completed for user ${user.id}`);

    return biBody(
      'Your password has been reset successfully. You can now sign in with your new password.',
      'تم إعادة تعيين كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.',
    );
  }

  /**
   * Render a duration string (e.g. "1h", "30m") as a human-readable label.
   */
  private humanizeDuration(duration: string): string {
    const parsed = parseDuration(duration);
    if (parsed === null) {
      return duration;
    }
    const units: Record<string, string> = {
      d: 'day',
      h: 'hour',
      m: 'minute',
      s: 'second',
    };
    const unit = units[parsed.unit] ?? '';
    return `${parsed.value} ${unit}${parsed.value === 1 ? '' : 's'}`;
  }

  /** Revoke the current session and every access/refresh token bound to it. */
  public async logout(userId: string, sessionId: string): Promise<void> {
    await this.sessionsService.deleteSessionById(userId, sessionId);
    this.logger.log(`User logged out - ID: ${userId}`);
  }

  /**
   * Logout user from all devices by deleting all sessions
   */
  public async logoutAll(userId: string): Promise<void> {
    await this.sessionsService.deleteAllUserSessions(userId);
    this.logger.log(`User logged out from all devices - ID: ${userId}`);
  }
}
