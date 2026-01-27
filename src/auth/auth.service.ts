import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';

import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds: number;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.bcryptRounds = this.configService.get<number>('BCRYPT_ROUNDS') ?? 12;
  }

  public async register(registerDto: RegisterDto): Promise<unknown> {
    const { email, password, phone, name, parentPhone } = registerDto;

    // Use generic error to prevent email/phone enumeration
    const existingUser = await this.userRepository.findOne({
      where: [{ email }, { phone }],
    });

    if (existingUser) {
      throw new ConflictException(
        'Registration failed. Please try different credentials.',
      );
    }

    const hashedPassword = await bcrypt.hash(password, this.bcryptRounds);

    const newUser = this.userRepository.create({
      name: name.trim(),
      email,
      phone,
      parent_phone: parentPhone ?? null,
      password_hash: hashedPassword,
      role: UserRole.STUDENT, // Default role for registration
      is_active: true,
      status: UserStatus.PENDING, // Pending approval
    });

    const savedUser = await this.userRepository.save(newUser);

    // Return pending approval message instead of tokens
    // Use the UUID directly as the user identifier
    return {
      message: 'Registration request received. Pending approval',
      userId: savedUser.id,
    };
  }

  public async login(loginDto: LoginDto): Promise<unknown> {
    const { email, password } = loginDto;

    const user = await this.userRepository
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email })
      .getOne();

    if (!user) {
      this.logger.warn(`Failed login attempt for non-existent user: ${email}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.password_hash === null || user.password_hash === '') {
      this.logger.warn(
        `Failed login attempt for Firebase-only account: ${email}`,
      );
      throw new UnauthorizedException(
        'This account uses Firebase authentication. Please sign in with your Firebase provider.',
      );
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      this.logger.warn(
        `Failed login attempt - invalid password for user: ${email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check user status (BREAKING CHANGE: new response format)
    if (user.status === UserStatus.PENDING) {
      this.logger.log(
        `Login attempt with pending account: ${email} (ID: ${user.id})`,
      );
      return {
        status: 'pending',
        message:
          'Your account is under review. Please wait for admin approval.',
      };
    }

    if (user.status === UserStatus.REJECTED) {
      this.logger.warn(
        `Login attempt with rejected account: ${email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException(
        `Account rejected: ${user.rejection_reason ?? 'Please contact support for more information.'}`,
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
    await this.storeRefreshToken(user.id, refreshToken);

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
  private async verifyRefreshToken(
    token: string,
    hash: string,
  ): Promise<boolean> {
    return await bcrypt.compare(token, hash);
  }

  /**
   * Store refresh token for a user with indexed token_id for fast lookup
   */
  private async storeRefreshToken(
    userId: string,
    refreshToken: string,
  ): Promise<void> {
    const hashedToken = await this.hashRefreshToken(refreshToken);
    const tokenId = this.generateTokenId(refreshToken);
    const refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRATION') ?? '7d';

    // Calculate expiration date based on duration string (e.g., "7d", "30d")
    const expiresAt = this.calculateTokenExpiration(refreshExpiresIn);

    await this.userRepository.update(userId, {
      refresh_token: hashedToken,
      refresh_token_id: tokenId,
      refresh_token_expires_at: expiresAt,
    });

    this.logger.debug(`Refresh token stored for user ${userId}`);
  }

  /**
   * Calculate token expiration date from duration string
   */
  private calculateTokenExpiration(duration: string): Date {
    const match = /^(\d+)([dhms])$/.exec(duration);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`Invalid duration format: ${duration}`);
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];
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
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Single BCrypt verification (not a loop)
    const isValid = await this.verifyRefreshToken(
      refreshToken,
      user.refresh_token,
    );

    if (!isValid) {
      this.logger.warn(
        `Refresh token verification failed - User: ${user.email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Check if token is expired
    if (
      !user.refresh_token_expires_at ||
      user.refresh_token_expires_at < new Date()
    ) {
      this.logger.warn(
        `Expired refresh token used - User: ${user.email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException('Refresh token expired');
    }

    // Check if user is active
    if (!user.is_active) {
      this.logger.warn(
        `Inactive user attempted token refresh - User: ${user.email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException('User account is inactive');
    }

    // Check user status (BREAKING CHANGE: new response format)
    if (user.status === UserStatus.PENDING) {
      this.logger.warn(
        `Pending user attempted token refresh - User: ${user.email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException(
        'Your account is under review. Please wait for admin approval.',
      );
    }

    if (user.status === UserStatus.REJECTED) {
      this.logger.warn(
        `Rejected user attempted token refresh - User: ${user.email} (ID: ${user.id})`,
      );
      throw new UnauthorizedException(
        `Account rejected: ${user.rejection_reason ?? 'Please contact support for more information.'}`,
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
    await this.storeRefreshToken(user.id, newRefreshToken);

    this.logger.log(`Token refreshed - User: ${user.email} (ID: ${user.id})`);

    // Return new response format with status
    return {
      status: 'approved',
      token: accessToken,
      refreshToken: newRefreshToken,
      role: user.role,
      userId: user.id,
    };
  }

  /**
   * Logout user by clearing refresh token and token_id
   */
  public async logout(userId: string): Promise<void> {
    await this.userRepository.update(userId, {
      refresh_token: null,
      refresh_token_id: null,
      refresh_token_expires_at: null,
    });

    this.logger.log(`User logged out - ID: ${userId}`);
  }
}
