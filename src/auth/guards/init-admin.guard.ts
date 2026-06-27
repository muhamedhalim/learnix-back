import { timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { Request } from 'express';
import { Repository } from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';

@Injectable()
export class InitAdminGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Layer 1: Check if any admin user already exists
    const adminExists = await this.checkAdminExists();
    if (adminExists) {
      throw new ForbiddenException(
        'Admin initialization has already been completed. This endpoint is now disabled.',
      );
    }

    // Layer 2: Validate secret token from header
    const initSecret = this.configService.get<string>('INIT_SECRET');
    if (initSecret === undefined || initSecret === '') {
      throw new ForbiddenException(
        'Admin initialization is not configured. INIT_SECRET environment variable is missing.',
      );
    }

    const providedSecret = request.headers['x-init-secret'] as
      | string
      | undefined;
    if (providedSecret === undefined || providedSecret === '') {
      throw new UnauthorizedException(
        'Admin initialization requires X-Init-Secret header.',
      );
    }

    // Use constant-time comparison to prevent timing attacks
    const providedBuffer = Buffer.from(providedSecret);
    const expectedBuffer = Buffer.from(initSecret);

    // Pad buffers to same length to prevent timing leaks
    const maxLen = Math.max(providedBuffer.length, expectedBuffer.length);
    const paddedProvided = Buffer.concat([
      providedBuffer,
      Buffer.alloc(maxLen - providedBuffer.length),
    ]);
    const paddedExpected = Buffer.concat([
      expectedBuffer,
      Buffer.alloc(maxLen - expectedBuffer.length),
    ]);

    if (!timingSafeEqual(paddedProvided, paddedExpected)) {
      throw new UnauthorizedException('Invalid initialization secret.');
    }

    return true;
  }

  private async checkAdminExists(): Promise<boolean> {
    // With enum-based roles, simply check if any user has admin role
    const adminUser = await this.userRepository.findOne({
      where: { role: UserRole.ADMIN },
    });

    return !!adminUser;
  }
}
