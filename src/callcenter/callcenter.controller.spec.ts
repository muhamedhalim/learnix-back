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

/**
 * DEF-012: the dashboard route must be scoped to the authenticated agent
 * (never a client-supplied id) and must reuse the same active-SLA-policy
 * resolution as the existing `sla()` route, rather than a second constant.
 */
describe('CallCenterController.dashboard (DEF-012)', () => {
  it('is call_center-scoped, matching the rest of the support projection', () => {
    expect(Reflect.getMetadata('roles', CallCenterController.prototype.dashboard)).toEqual([
      'call_center',
    ]);
  });

  it('resolves counts for the authenticated agent using the active SLA warning window', async () => {
    const dashboardCounts = jest.fn().mockResolvedValue({ open_tickets: 3 });
    const activePolicy = jest.fn().mockResolvedValue({ warning_window_hours: 6 });
    const controller = new CallCenterController(
      {} as never,
      {} as never,
      {} as never,
      { dashboardCounts } as never,
      { activePolicy } as never,
    );

    const result = await controller.dashboard({ userId: 'agent-1' } as never);

    expect(dashboardCounts).toHaveBeenCalledWith('agent-1', 6);
    expect(result).toEqual({ open_tickets: 3 });
  });

  it('falls back to the same default policy the sla() route uses when no policy is configured', async () => {
    const dashboardCounts = jest.fn().mockResolvedValue({ open_tickets: 0 });
    const activePolicy = jest.fn().mockResolvedValue(null);
    const controller = new CallCenterController(
      {} as never,
      {} as never,
      {} as never,
      { dashboardCounts } as never,
      { activePolicy } as never,
    );

    await controller.dashboard({ userId: 'agent-2' } as never);

    expect(dashboardCounts).toHaveBeenCalledWith('agent-2', 4);
  });
});
