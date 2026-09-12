import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { UserRequest } from '../../common/interfaces/user-request.interface';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      string[] | undefined
    >('roles', [context.getHandler(), context.getClass()]);

    if (requiredRoles === undefined || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<UserRequest>();
    const { user } = request;

    // A null role is a marketplace-only identity carrying no academic role.
    // It satisfies no `@Roles(...)` requirement, so it is denied here rather
    // than being compared — academic routes stay closed to it by default.
    if (user === undefined || user.role === null || user.role === '') {
      return false;
    }

    // Check if user's single role is in the allowed roles array
    return requiredRoles.includes(user.role);
  }
}
