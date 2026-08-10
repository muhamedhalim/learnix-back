import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import { RolesGuard } from '../../auth/guards/roles.guard';
import { AdminGamificationController } from './admin-gamification.controller';

describe('AdminGamificationController (DEF-018)', () => {
  it('is admin-only (class-level @Roles, applied to every route)', () => {
    expect(Reflect.getMetadata('roles', AdminGamificationController)).toEqual(['admin']);
  });

  it('RolesGuard rejects a teacher/call_center caller on every route', () => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of ['history', 'current', 'create', 'setEnabled'] as const) {
      const context = {
        getHandler: () => AdminGamificationController.prototype[handler],
        getClass: () => AdminGamificationController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: 'teacher' } }) }),
      } as unknown as ExecutionContext;
      expect(guard.canActivate(context)).toBe(false);
    }
  });

  it('create() attributes the new version to the authenticated admin, never a client-supplied id', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'rule-set-1', version_number: 2 });
    const controller = new AdminGamificationController({ create } as never);
    const dto = {
      xp_base_by_difficulty: { easy: 10, medium: 20, hard: 35, expert: 55 },
      combo_bonuses: [],
      streak_daily_bonus: 25,
      streak_milestones: [],
    } as never;

    await controller.create(dto, { userId: 'admin-1' } as never);

    expect(create).toHaveBeenCalledWith(dto, 'admin-1');
  });

  it('current() and history() delegate straight to the service', async () => {
    const resolveCurrent = jest.fn().mockResolvedValue({ version_number: 1 });
    const history = jest.fn().mockResolvedValue([{ version_number: 1 }]);
    const controller = new AdminGamificationController({ resolveCurrent, history } as never);

    await expect(controller.current()).resolves.toEqual({ version_number: 1 });
    await expect(controller.history()).resolves.toEqual([{ version_number: 1 }]);
  });

  it('setEnabled() passes the path id and body flag through unchanged', async () => {
    const setEnabled = jest.fn().mockResolvedValue({ id: 'rule-set-1', enabled: false });
    const controller = new AdminGamificationController({ setEnabled } as never);

    await controller.setEnabled('rule-set-1', { enabled: false });

    expect(setEnabled).toHaveBeenCalledWith('rule-set-1', false);
  });
});
