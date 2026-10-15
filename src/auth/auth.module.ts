import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FirebaseModule } from '../firebase/firebase.module';
import { GuardiansModule } from '../guardians/guardians.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { capAccessTokenTtl } from './auth-token.config';
import { FirebaseAuthGuard } from './guards/firebase-auth.guard';
import { HybridAuthGuard } from './guards/hybrid-auth.guard';
import { OptionalHybridAuthGuard } from './guards/optional-hybrid-auth.guard';
import { JwtStrategy } from './jwt.strategy';

@Global()
@Module({
  imports: [
    FirebaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET') ?? '',
        signOptions: {
          expiresIn: capAccessTokenTtl(configService.get<string>('JWT_EXPIRATION')) as NonNullable<
            JwtSignOptions['expiresIn']
          >,
        },
      }),
      inject: [ConfigService],
    }),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    TypeOrmModule.forFeature([User]),
    UsersModule,
    GuardiansModule,
  ],
  controllers: [AuthController],
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
