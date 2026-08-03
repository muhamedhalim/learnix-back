import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

import { Request } from 'express';

import { FirebaseService } from '../../firebase/firebase.service';
import { UserStatus } from '../../users/entities/user-status.enum';
import { UsersService } from '../../users/users.service';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly usersService: UsersService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (authHeader?.startsWith('Bearer ') !== true) {
      throw new UnauthorizedException('No Firebase token provided');
    }

    const firebaseToken = authHeader.split(' ')[1];

    if (firebaseToken === undefined || firebaseToken === '') {
      throw new UnauthorizedException('Malformed authorization header');
    }

    try {
      const decodedToken = await this.firebaseService.verifyToken(firebaseToken);
      const user = await this.usersService.syncFirebaseUser(decodedToken);
      if (!user.is_active || user.status !== UserStatus.APPROVED) {
        throw new UnauthorizedException('User account is not approved or active');
      }
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid Firebase token');
    }
  }
}
