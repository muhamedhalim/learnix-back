import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { User } from '../users/entities/user.entity';
import { UserRole } from '../users/entities/user-role.enum';
import { UserStatus } from '../users/entities/user-status.enum';

export type AdminInitOutcome = 'created' | 'already_exists' | 'skipped_missing_env';

export interface AdminInitResult {
  outcome: AdminInitOutcome;
  adminEmail?: string;
}

const POSTGRES_UNIQUE_VIOLATION = '23505';

/**
 * Single source of truth for bootstrapping the platform's first administrator
 * from `ADMIN_INIT_EMAIL` / `ADMIN_INIT_PASSWORD`.
 *
 * Called from exactly two places — `main.ts` (every process boot, before the
 * HTTP server starts listening) and `seed-admin.ts` (manual `npm run
 * seed:admin`) — both invoking this same `initialize()` method. There is no
 * second implementation of "how an admin gets created."
 *
 * Email normalization (`trim().toLowerCase()`) here matches
 * `AuthService.login()`/`register()`/`forgotPassword()` exactly, so the row
 * this creates is queryable by the same login flow without a special case.
 * Password hashing uses `bcryptjs` with the same `BCRYPT_ROUNDS` config
 * `AuthService` uses — bcrypt embeds its cost factor in the hash string
 * itself, so `bcrypt.compare()` works regardless, but sourcing the rounds
 * from the same config keeps the two aligned rather than by coincidence.
 */
@Injectable()
export class AdminInitializationService {
  private readonly logger = new Logger(AdminInitializationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  public async initialize(): Promise<AdminInitResult> {
    const rawEmail = this.configService.get<string>('ADMIN_INIT_EMAIL');
    const rawPassword = this.configService.get<string>('ADMIN_INIT_PASSWORD');

    if (
      rawEmail === undefined ||
      rawEmail.trim() === '' ||
      rawPassword === undefined ||
      rawPassword === ''
    ) {
      this.logger.warn(
        'ADMIN_INIT_EMAIL / ADMIN_INIT_PASSWORD are not configured. Admin initialization skipped.',
      );
      return { outcome: 'skipped_missing_env' };
    }

    const email = rawEmail.trim().toLowerCase();

    try {
      return await this.dataSource.transaction(async (manager) => {
        const userRepo = manager.getRepository(User);

        // Case 2: an admin already exists anywhere in the system (not
        // necessarily at this exact email) — this bootstrap step is done.
        // Never touches an existing row: no password reset, no overwrite.
        const existingAdmin = await userRepo.findOne({ where: { role: UserRole.ADMIN } });
        if (existingAdmin) {
          this.logger.log('Administrator already exists. Skipping initialization.');
          return { outcome: 'already_exists', adminEmail: existingAdmin.email };
        }

        const bcryptRounds = this.configService.get<number>('BCRYPT_ROUNDS') ?? 12;
        const password_hash = await bcrypt.hash(rawPassword, bcryptRounds);

        const admin = userRepo.create({
          name: 'Admin User',
          username: 'admin',
          email,
          phone: '01099999999',
          password_hash,
          role: UserRole.ADMIN,
          status: UserStatus.APPROVED,
          is_active: true,
        });

        try {
          await userRepo.save(admin);
        } catch (error) {
          // A concurrent process (e.g. `npm run seed:admin` racing this same
          // boot) may have inserted the same row between our check and our
          // insert — the unique constraint on `email` catches it. Treat that
          // as success, not a crash: the invariant ("exactly one admin
          // exists") still holds, just created by the other caller.
          if (this.isUniqueViolation(error)) {
            this.logger.log(
              'Administrator already exists (created concurrently). Skipping initialization.',
            );
            return { outcome: 'already_exists' };
          }
          throw error;
        }

        this.logger.log('Initial administrator created successfully');
        return { outcome: 'created', adminEmail: email };
      });
    } catch (error) {
      this.logger.error(
        'Admin initialization failed',
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === POSTGRES_UNIQUE_VIOLATION
    );
  }
}
