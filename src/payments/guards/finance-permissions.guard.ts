import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { UserRequest } from '../../common/interfaces/user-request.interface';
import { FINANCE_PERMISSIONS_KEY } from '../decorators/finance-permissions.decorator';
import type { FinancePermission } from '../finance-permissions';

/** Database-backed permission check; JWT role membership alone is insufficient. */
@Injectable()
export class FinancePermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<FinancePermission[] | undefined>(
      FINANCE_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<UserRequest>();
    const userId = request.user?.userId;
    if (!userId) throw new ForbiddenException('Finance permission is required');
    const principalPermissions = request.user?.financePermissions;
    // Cookie principals carry role and permissions from the live statement that
    // authenticated this request; any other principal falls back to a DB read.
    let role: string | null | undefined;
    let permissions: readonly string[];
    if (Array.isArray(principalPermissions)) {
      role = request.user?.role;
      permissions = principalPermissions;
    } else {
      const user = await this.users.findOne({
        where: { id: userId },
        select: ['id', 'role', 'finance_permissions'],
      });
      role = user?.role;
      permissions = user?.finance_permissions ?? [];
    }
    if (role !== 'admin') throw new ForbiddenException('Finance permission is required');
    const granted = new Set(permissions);
    if (!required.every((permission) => granted.has(permission))) {
      throw new ForbiddenException('Finance permission is required');
    }
    return true;
  }
}
