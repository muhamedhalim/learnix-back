import { CanActivate, ExecutionContext,Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UserRequest } from '../../common/interfaces/user-request.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[] | undefined>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    if(requiredRoles === undefined || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<UserRequest>();
    const user = request.user;

    if(!user?.role) {
      return false;
    }

    // Check if user's single role is in the allowed roles array
    return requiredRoles.includes(user.role);
  }
}
