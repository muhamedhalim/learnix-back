import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { User } from './users/entities/user.entity';
import { UserRole } from './users/entities/user-role.enum';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private readonly startTime: number;

  constructor(
    private configService: ConfigService,
    private dataSource: DataSource,
    @InjectRepository(User)
    private userRepository: Repository<User>,
  ) {
    this.startTime = Date.now();
  }

  getHello(): string {
    return 'Educational Platform API';
  }

  async getHealth() {
    const now = Date.now();
    const uptimeMs = now - this.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);

    let databaseStatus = 'disconnected';
    try {
      if (this.dataSource.isInitialized) {
        await this.dataSource.query('SELECT 1');
        databaseStatus = 'connected';
      }
    } catch {
      databaseStatus = 'error';
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: uptimeSeconds,
      database: databaseStatus,
      version: '1.0.0',
    };
  }

  /**
   * Initialize admin user (one-time setup)
   * Requires ADMIN_INIT_EMAIL and ADMIN_INIT_PASSWORD environment variables
   */
  async initAdmin() {
    const results: string[] = [];

    // Validate required environment variables
    const adminEmail = this.configService.get<string>('ADMIN_INIT_EMAIL');
    const adminPassword = this.configService.get<string>('ADMIN_INIT_PASSWORD');

    if (!adminEmail || !adminPassword) {
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
      username: 'admin',
      email: adminEmail,
      password_hash: hashedPassword,
      first_name: 'Admin',
      last_name: 'User',
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
  getRoles() {
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
