import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from '../auth/guards/roles.guard';
import { UsersController } from './users.controller';

describe('UsersController Call Center workforce authorization', () => {
  function contextFor(role: string): ExecutionContext {
    return {
      getHandler: () => UsersController.prototype.findCallCenterEmployees,
      getClass: () => UsersController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
  }

  it('declares the workforce list Admin-only in backend metadata', () => {
    expect(Reflect.getMetadata('roles', UsersController.prototype.findCallCenterEmployees)).toEqual(
      ['admin'],
    );
  });

  it('prevents Call Center staff from listing or managing their own workforce', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor('call_center'))).toBe(false);
  });

  it('allows an Admin to access the workforce list', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor('admin'))).toBe(true);
  });
});
