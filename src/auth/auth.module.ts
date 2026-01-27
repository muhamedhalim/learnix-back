import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FirebaseModule } from '../firebase/firebase.module';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { FirebaseAuthController } from './firebase-auth.controller';
import { FirebaseAuthGuard } from './guards/firebase-auth.guard';
import { HybridAuthGuard } from './guards/hybrid-auth.guard';
import { OptionalHybridAuthGuard } from './guards/optional-hybrid-auth.guard';
import { JwtStrategy } from './jwt.strategy';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get<string>('JWT_EXPIRATION') ?? '15m',
        },
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    FirebaseModule,
  ],
  controllers: [AuthController, FirebaseAuthController],
  providers: [
    AuthService,
    JwtStrategy,
    FirebaseAuthGuard,
    HybridAuthGuard,
    OptionalHybridAuthGuard,
  ],
  exports: [
    AuthService,
    JwtStrategy,
    PassportModule,
    FirebaseAuthGuard,
    HybridAuthGuard,
    OptionalHybridAuthGuard,
  ],
})
export class AuthModule {}
