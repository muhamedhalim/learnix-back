import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { Repository } from 'typeorm';

import { User } from './users/entities/user.entity';
import { UserRole } from './users/entities/user-role.enum';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly startTime: number;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {
    this.startTime = Date.now();
  }

  public getHello(): string {
    return 'Educational Platform API';
  }

  public getHealth(): {
    status: string;
    timestamp: string;
    uptime: number;
    environment: string;
    version: string;
  } {
    const now = Date.now();
    const uptimeMs = now - this.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: uptimeSeconds,
      environment: this.configService.get<string>('NODE_ENV') ?? 'development',
      version: '1.0.0',
    };
  }

  /**
   * Initialize admin user (one-time setup)
   * Requires ADMIN_INIT_EMAIL and ADMIN_INIT_PASSWORD environment variables
   */
  public async initAdmin(): Promise<{
    success: boolean;
    message: string;
    adminEmail?: string;
    results: string[];
  }> {
    const results: string[] = [];

    // Validate required environment variables
    const adminEmail = this.configService.get<string>('ADMIN_INIT_EMAIL');
    const adminPassword = this.configService.get<string>('ADMIN_INIT_PASSWORD');

    if (
      adminEmail === undefined ||
      adminEmail === '' ||
      adminPassword === undefined ||
      adminPassword === ''
    ) {
      throw new BadRequestException(
        'Admin initialization requires ADMIN_INIT_EMAIL and ADMIN_INIT_PASSWORD environment variables to be set.',
      );
    }

    // Check if admin already exists
    const existingAdmin = await this.userRepository.findOne({
      where: { email: adminEmail },
    });

    if (existingAdmin) {
      results.push(`Admin user already exists: ${adminEmail}`);
      return {
        success: true,
        message: 'Admin already exists',
        adminEmail,
        results,
      };
    }

    // Check if any admin exists at all
    const anyAdmin = await this.userRepository.findOne({
      where: { role: UserRole.ADMIN },
    });

    if (anyAdmin) {
      results.push('An admin user already exists in the system');
      return {
        success: false,
        message: 'Admin initialization already completed',
        results,
      };
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash(adminPassword, 12);

    const admin = this.userRepository.create({
      name: 'Admin User',
      email: adminEmail,
      phone: '01000000000', // Default admin phone
      password_hash: hashedPassword,
      role: UserRole.ADMIN,
      is_active: true,
    });

    await this.userRepository.save(admin);
    results.push(`Admin user created: ${adminEmail}`);

    this.logger.log(`Admin user initialized: ${adminEmail}`);

    return {
      success: true,
      message: 'Admin initialization completed',
      adminEmail,
      results,
    };
  }

  /**
   * Get available user roles (for documentation/API reference)
   */
  public getRoles(): {
    roles: string[];
    descriptions: Record<string, string>;
  } {
    return {
      roles: Object.values(UserRole),
      descriptions: {
        [UserRole.ADMIN]: 'Platform administrator with full access',
        [UserRole.CALL_CENTER]: 'Call center staff for student support',
        [UserRole.TEACHER]: 'Teacher who creates lessons and exams',
        [UserRole.STUDENT]: 'Student who purchases and accesses content',
      },
    };
  }
}
