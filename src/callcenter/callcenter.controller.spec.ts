import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from '../auth/guards/roles.guard';
import { CallCenterController } from './callcenter.controller';

/**
 * DEF-003: the legacy student administrative update route must be Admin-only.
 * These are unit-level proofs that complement the PostgreSQL E2E boundary
 * test in test/e2e/call-center-legacy-student-update.e2e-spec.ts, which
 * proves the same boundary against a real HTTP + DB stack.
 */
describe('CallCenterController.updateStudent authorization (DEF-003)', () => {
  it('declares the legacy update route Admin-only in backend metadata', () => {
    const roles = Reflect.getMetadata(
      'roles',
      CallCenterController.prototype.updateStudent,
    ) as string[];
    expect(roles).toEqual(['admin']);
  });

  it('leaves the legacy GET routes Admin-only (unchanged)', () => {
    expect(
      Reflect.getMetadata('roles', CallCenterController.prototype.getStudentProfile),
    ).toEqual(['admin']);
    expect(
      Reflect.getMetadata('roles', CallCenterController.prototype.searchStudents),
    ).toEqual(['admin']);
  });

  it('leaves the Call Center support projection routes unchanged', () => {
    expect(
      Reflect.getMetadata('roles', CallCenterController.prototype.searchSupportUsers),
    ).toEqual(['call_center']);
    expect(
      Reflect.getMetadata('roles', CallCenterController.prototype.getSupportUser),
    ).toEqual(['call_center']);
  });

  function contextFor(role: string): ExecutionContext {
    return {
      getHandler: () => CallCenterController.prototype.updateStudent,
      getClass: () => CallCenterController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role } }),
      }),
    } as unknown as ExecutionContext;
  }

  it('RolesGuard denies call_center on the legacy update route before the handler runs', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor('call_center'))).toBe(false);
  });

  it('RolesGuard allows admin on the legacy update route', () => {
    const guard = new RolesGuard(new Reflector());
    expect(guard.canActivate(contextFor('admin'))).toBe(true);
  });
});
