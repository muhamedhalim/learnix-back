import { Global, Module, forwardRef } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FirebaseModule } from '../firebase/firebase.module';
import { StudentsModule } from '../students/students.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FirebaseAuthController } from './firebase-auth.controller';
import { FirebaseAuthGuard } from './guards/firebase-auth.guard';
import { HybridAuthGuard } from './guards/hybrid-auth.guard';
import { OptionalHybridAuthGuard } from './guards/optional-hybrid-auth.guard';
import { JwtStrategy } from './jwt.strategy';

const MAX_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_TTL = '15m';

function durationToMilliseconds(duration: string): number | null {
  const match = /^(\d+)([dhms])$/.exec(duration);
  if (match?.[1] === undefined || match[2] === undefined) return null;

  const value = Number.parseInt(match[1], 10);
  const multiplierByUnit: Record<string, number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000,
  };

  return value * (multiplierByUnit[match[2]] ?? 0);
}

function capAccessTokenTtl(configured: string | undefined): string {
  const ttl = configured ?? DEFAULT_ACCESS_TOKEN_TTL;
  const ttlMs = durationToMilliseconds(ttl);
  if (ttlMs === null || ttlMs > MAX_ACCESS_TOKEN_TTL_MS) {
    return DEFAULT_ACCESS_TOKEN_TTL;
  }
  return ttl;
}

@Global()
@Module({
  imports: [
    FirebaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? '',
        signOptions: {
          expiresIn: capAccessTokenTtl(configService.get<string>('JWT_EXPIRATION')) as any,
        },
      }),
      inject: [ConfigService],
    }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    TypeOrmModule.forFeature([User]),
    UsersModule,
    forwardRef(() => StudentsModule),
  ],
  controllers: [AuthController, FirebaseAuthController],
  providers: [
    AuthService,
    FirebaseAuthGuard,
    HybridAuthGuard,
    JwtStrategy,
    OptionalHybridAuthGuard,
  ],
  exports: [
    AuthService,
    FirebaseAuthGuard,
    HybridAuthGuard,
    JwtStrategy,
    OptionalHybridAuthGuard,
    PassportModule,
  ],
})
export class AuthModule {}
