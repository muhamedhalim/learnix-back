import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { FirebaseService } from '../../firebase/firebase.service';
import { UsersService } from '../../users/users.service';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private firebaseService: FirebaseService,
    private usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('No Firebase token provided');
    }

    const firebaseToken = authHeader.split(' ')[1];

    if (!firebaseToken) {
      throw new UnauthorizedException('Malformed authorization header');
    }

    try {
      const decodedToken =
        await this.firebaseService.verifyToken(firebaseToken);
      const user = await this.usersService.syncFirebaseUser(decodedToken);
      request.user = user;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid Firebase token');
    }
  }
}
