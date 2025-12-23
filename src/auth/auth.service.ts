import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly bcryptRounds: number;

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.bcryptRounds = this.configService.get<number>('BCRYPT_ROUNDS') || 12;
  }

  async register(registerDto: RegisterDto) {
    const { email, password, username, full_name } = registerDto;

    // Use generic error to prevent username/email enumeration
    const existingUser = await this.userRepository.findOne({
      where: [{ email }, { username }],
    });

    if (existingUser) {
      throw new ConflictException(
        'Registration failed. Please try different credentials.',
      );
    }

    const hashedPassword = await bcrypt.hash(password, this.bcryptRounds);

    const nameParts = full_name.trim().split(' ');
    const first_name = nameParts[0] || '';
    const last_name = nameParts.slice(1).join(' ') || '';

    const newUser = this.userRepository.create({
      username,
      email,
      password_hash: hashedPassword,
      first_name,
      last_name,
      role: UserRole.STUDENT, // Default role for registration
      is_active: true,
    });

    const savedUser = await this.userRepository.save(newUser);

    const payload = {
      sub: savedUser.id,
      email: savedUser.email,
      username: savedUser.username,
      role: savedUser.role,
    };

    const access_token = this.jwtService.sign(payload);

    // Generate and store refresh token
    const refresh_token = this.generateRefreshToken();
    await this.storeRefreshToken(savedUser.id, refresh_token);

    return {
      access_token,
      refresh_token,
      user: {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        full_name: `${savedUser.first_name} ${savedUser.last_name}`.trim(),
        role: savedUser.role,
        isActive: savedUser.is_active,
      },
    };
  }

  async login(loginDto: LoginDto) {
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

    if (!user.password_hash) {
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

    const payload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    const access_token = this.jwtService.sign(payload);

    // Generate and store refresh token
    const refresh_token = this.generateRefreshToken();
    await this.storeRefreshToken(user.id, refresh_token);

    return {
      access_token,
      refresh_token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: `${user.first_name} ${user.last_name}`.trim(),
        role: user.role,
        isActive: user.is_active,
      },
    };
  }

  async validateUser(payload: { sub: number; email: string }): Promise<{
    userId: number;
    email: string;
    username: string;
    role: UserRole;
  } | null> {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
    });

    if (user && user.is_active) {
      return {
        userId: user.id,
        email: user.email,
        username: user.username,
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
    return bcrypt.hash(token, this.bcryptRounds);
  }

  /**
   * Verify refresh token against stored hash
   */
  private async verifyRefreshToken(
    token: string,
    hash: string,
  ): Promise<boolean> {
    return bcrypt.compare(token, hash);
  }

  /**
   * Store refresh token for a user with indexed token_id for fast lookup
   */
  private async storeRefreshToken(
    userId: number,
    refreshToken: string,
  ): Promise<void> {
    const hashedToken = await this.hashRefreshToken(refreshToken);
    const tokenId = this.generateTokenId(refreshToken);
    const refreshExpiresIn =
      this.configService.get<string>('JWT_REFRESH_EXPIRATION') || '7d';

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
    const match = duration.match(/^(\d+)([dhms])$/);
    if (!match || !match[1] || !match[2]) {
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
    }

    return now;
  }

  /**
   * Refresh access token using refresh token
   * Optimized: O(1) database lookup via indexed token_id
   */
  async refresh(refreshToken: string) {
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

    if (!user || !user.refresh_token) {
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

    // Generate new access token
    const payload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
    };

    const access_token = this.jwtService.sign(payload);

    // Generate new refresh token (token rotation for security)
    const newRefreshToken = this.generateRefreshToken();
    await this.storeRefreshToken(user.id, newRefreshToken);

    this.logger.log(`Token refreshed - User: ${user.email} (ID: ${user.id})`);

    return {
      access_token,
      refresh_token: newRefreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: `${user.first_name} ${user.last_name}`.trim(),
        role: user.role,
        isActive: user.is_active,
      },
    };
  }

  /**
   * Logout user by clearing refresh token and token_id
   */
  async logout(userId: number): Promise<void> {
    await this.userRepository.update(userId, {
      refresh_token: null,
      refresh_token_id: null,
      refresh_token_expires_at: null,
    });

    this.logger.log(`User logged out - ID: ${userId}`);
  }
}
