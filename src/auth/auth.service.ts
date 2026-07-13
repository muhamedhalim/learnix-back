import * as crypto from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';

import { parseDuration } from '../common/utils/duration.util';
import { biBody } from '../i18n/error-translator.util';
import { GuardianRelationship } from '../guardians/entities';
import { PreferredLanguage } from '../guardians/entities/preferred-language.enum';
import { GuardiansService } from '../guardians/guardians.service';
import { MailService } from '../mail/mail.service';
import { StudentProfile } from '../students/entities/student-profile.entity';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { SessionsService } from '../users/sessions.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

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
   */
  public async register(
    registerDto: RegisterDto,
    preferredLanguage: PreferredLanguage = PreferredLanguage.EN,
  ): Promise<unknown> {
    const { password, phone, name, requestedRole, parentPhone, qualifications, yearsOfExperience, bio } =
      registerDto;
    // Normalized identically to login()/forgotPassword()/AdminInitializationService
    // so every entry point that writes or queries `email` agrees on its casing.
    const email = registerDto.email.trim().toLowerCase();

    // Use generic error to prevent email/phone enumeration
    const existingUser = await this.userRepository.findOne({
      where: [{ email }, { phone }],
    });

    if (existingUser) {
      throw new ConflictException(
        biBody(
          'Registration failed. Please try different credentials.',
          'فشل التسجيل. يرجى تجربة بيانات مختلفة.',
        ),
      );
    }

    const hashedPassword = await bcrypt.hash(password, this.bcryptRounds);

    // Auto-generate username from email prefix + random suffix for uniqueness
    const emailPrefix = (email.split('@')[0] ?? '').replace(/[^a-zA-Z0-9_]/g, '_');
    const randomSuffix = crypto.randomBytes(3).toString('hex');
    const username = `${emailPrefix}_${randomSuffix}`;

    const savedUser = await this.dataSource.transaction(async (manager) => {
      const user = manager.create(User, {
        username,
        name: name.trim(),
        email,
        phone,
        password_hash: hashedPassword,
        role: requestedRole,
        is_active: true,
        status: UserStatus.PENDING, // Pending admin approval — see docstring above.
        preferred_language: preferredLanguage,
      });
      const createdUser = await manager.save(User, user);

      if (requestedRole === UserRole.STUDENT) {
        const profile = manager.create(StudentProfile, {
          user_id: createdUser.id,
          grade_level: null, // Unknown at registration; set by admin after approval.
          notification_settings: {
            sms_enabled: true,
            email_enabled: true,
            lesson_reminders: true,
            exam_results: true,
            payment_notifications: true,
          },
        });
        await manager.save(StudentProfile, profile);

        // RegisterDto guarantees `parentPhone` is present for a student
        // request (`@ValidateIf` + `@IsNotEmpty`). Becomes an UNVERIFIED
        // Guardian: captured, but unable to receive any educational
        // notification until an OTP proves the parent owns it.
        await this.guardiansService.linkGuardianWith(manager, createdUser.id, {
          phone: parentPhone as string,
          relationship: GuardianRelationship.OTHER,
          is_primary: true,
        });
      } else {
        const profile = manager.create(TeacherProfile, {
          user_id: createdUser.id,
          // RegisterDto guarantees these are present for a teacher request.
          qualifications: qualifications as string,
          years_of_experience: yearsOfExperience as number,
          bio: bio ?? null,
          rating: 0,
          total_ratings: 0,
        });
        await manager.save(TeacherProfile, profile);
      }

      return createdUser;
    });

    // Return pending approval message instead of tokens
    // Use the UUID directly as the user identifier
    return {
      ...biBody(
        'Registration request received. Pending approval',
        'تم استلام طلب التسجيل. بانتظار الموافقة',
      ),
      userId: savedUser.id,
    };
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

    const accessToken = this.jwtService.sign(payload);

    // Generate and store refresh token
    const refreshToken = this.generateRefreshToken();
    const { tokenId, expiresAt } = await this.storeRefreshToken(user.id, refreshToken);

    // Create session record for device tracking
    await this.sessionsService.createSession({
      userId: user.id,
      refreshTokenId: tokenId,
      deviceInfo,
      ipAddress,
      expiresAt,
    });

    // Return new response format with status
    return {
      status: 'approved',
      token: accessToken,
      refreshToken,
      role: user.role,
      userId: user.id,
    };
  }

  public async validateUser(payload: { sub: string; email: string }): Promise<{
    userId: string;
    email: string;
    name: string;
    role: UserRole;
  } | null> {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
    });

    if (user?.is_active === true) {
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
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
   * Store refresh token for a user with indexed token_id for fast lookup
   * Returns tokenId and expiresAt for session creation
   */
  private async storeRefreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<{ tokenId: string; expiresAt: Date }> {
    const hashedToken = await this.hashRefreshToken(refreshToken);
    const tokenId = this.generateTokenId(refreshToken);
    const refreshExpiresIn = this.configService.get<string>('JWT_REFRESH_EXPIRATION') ?? '7d';

    // Calculate expiration date based on duration string (e.g., "7d", "30d")
    const expiresAt = this.calculateTokenExpiration(refreshExpiresIn);

    await this.userRepository.update(userId, {
      refresh_token: hashedToken,
      refresh_token_id: tokenId,
      refresh_token_expires_at: expiresAt,
    });

    this.logger.debug(`Refresh token stored for user ${userId}`);

    return { tokenId, expiresAt };
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
    // Generate token ID for O(1) indexed lookup
    const tokenId = this.generateTokenId(refreshToken);

    // Direct O(1) lookup by indexed token_id
    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.refresh_token')
      .addSelect('user.refresh_token_expires_at')
      .where('user.refresh_token_id = :tokenId', { tokenId })
      .andWhere('user.refresh_token IS NOT NULL')
      .getOne();

    if (user?.refresh_token == null) {
      this.logger.warn('Invalid refresh token attempt');
      throw new UnauthorizedException(biBody('Invalid refresh token', 'رمز التحديث غير صالح'));
    }

    // Single BCrypt verification (not a loop)
    const isValid = await this.verifyRefreshToken(refreshToken, user.refresh_token);

    if (!isValid) {
      this.logger.warn(`Refresh token verification failed - ID: ${user.id}`);
      throw new UnauthorizedException(biBody('Invalid refresh token', 'رمز التحديث غير صالح'));
    }

    // Check if token is expired
    if (!user.refresh_token_expires_at || user.refresh_token_expires_at < new Date()) {
      this.logger.warn(`Expired refresh token used - ID: ${user.id}`);
      throw new UnauthorizedException(biBody('Refresh token expired', 'انتهت صلاحية رمز التحديث'));
    }

    // Check if user is active
    if (!user.is_active) {
      this.logger.warn(`Inactive user attempted token refresh - ID: ${user.id}`);
      throw new UnauthorizedException(biBody('User account is inactive', 'حساب المستخدم غير نشط'));
    }

    // Check user status (BREAKING CHANGE: new response format)
    if (user.status === UserStatus.PENDING) {
      this.logger.warn(`Pending user attempted token refresh - ID: ${user.id}`);
      throw new UnauthorizedException(
        biBody(
          'Your account is under review. Please wait for admin approval.',
          'حسابك قيد المراجعة. يرجى انتظار موافقة الإدارة.',
        ),
      );
    }

    if (user.status === UserStatus.REJECTED) {
      this.logger.warn(`Rejected user attempted token refresh - ID: ${user.id}`);
      throw new UnauthorizedException(
        biBody(
          `Account rejected: ${user.rejection_reason ?? 'Please contact support for more information.'}`,
          `تم رفض الحساب: ${user.rejection_reason ?? 'يرجى التواصل مع الدعم لمزيد من المعلومات.'}`,
        ),
      );
    }

    // Generate new access token
    const payload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload);

    // Generate new refresh token (token rotation for security)
    const newRefreshToken = this.generateRefreshToken();
    const { tokenId: newTokenId, expiresAt: newExpiresAt } = await this.storeRefreshToken(
      user.id,
      newRefreshToken,
    );

    // Update session with new token ID (token rotation)
    await this.sessionsService.updateSessionTokenId(tokenId, newTokenId, newExpiresAt);

    this.logger.log(`Token refreshed - ID: ${user.id}`);

    // Return new response format with status
    return {
      status: 'approved',
      token: accessToken,
      refreshToken: newRefreshToken,
      role: user.role,
      userId: user.id,
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

    const frontendUrl = (this.configService.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '');
    const resetUrl = `${frontendUrl}/auth/reset-password?token=${rawToken}`;

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
      refresh_token: null,
      refresh_token_id: null,
      refresh_token_expires_at: null,
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

  /**
   * Logout user by clearing refresh token and token_id
   */
  public async logout(userId: string, refreshTokenId?: string): Promise<void> {
    // Delete the session if refreshTokenId is provided
    if (refreshTokenId !== undefined && refreshTokenId !== '') {
      await this.sessionsService.deleteSessionByTokenId(refreshTokenId);
    }

    await this.userRepository.update(userId, {
      refresh_token: null,
      refresh_token_id: null,
      refresh_token_expires_at: null,
    });

    this.logger.log(`User logged out - ID: ${userId}`);
  }

  /**
   * Logout user from all devices by deleting all sessions
   */
  public async logoutAll(userId: string): Promise<void> {
    await this.sessionsService.deleteAllUserSessions(userId);

    await this.userRepository.update(userId, {
      refresh_token: null,
      refresh_token_id: null,
      refresh_token_expires_at: null,
    });

    this.logger.log(`User logged out from all devices - ID: ${userId}`);
  }
}
