import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';

import { RolesGuard } from '../../auth/guards/roles.guard';
import { TeacherGamificationController } from './teacher-gamification.controller';

describe('TeacherGamificationController (DEF-018)', () => {
  it('is teacher-only (class-level @Roles, applied to every route)', () => {
    expect(Reflect.getMetadata('roles', TeacherGamificationController)).toEqual(['teacher']);
  });

  it('RolesGuard rejects an admin/student caller on every route', () => {
    const guard = new RolesGuard(new Reflector());
    for (const handler of ['list', 'create', 'update'] as const) {
      const context = {
        getHandler: () => TeacherGamificationController.prototype[handler],
        getClass: () => TeacherGamificationController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: 'student' } }) }),
      } as unknown as ExecutionContext;
      expect(guard.canActivate(context)).toBe(false);
    }
  });

  it('list() and create() scope to the authenticated teacher id, never a client-supplied one', async () => {
    const listForTeacher = jest.fn().mockResolvedValue([]);
    const createForTeacher = jest.fn().mockResolvedValue({ id: 'campaign-1' });
    const controller = new TeacherGamificationController({ listForTeacher, createForTeacher } as never);
    const dto = { lesson_id: 'lesson-1', title: 'Push', bonus_xp: 10 } as never;

    await controller.list({ userId: 'teacher-1' } as never);
    await controller.create(dto, { userId: 'teacher-1' } as never);

    expect(listForTeacher).toHaveBeenCalledWith('teacher-1');
    expect(createForTeacher).toHaveBeenCalledWith('teacher-1', dto);
  });

  it('update() scopes to the authenticated teacher id, not a body/query value', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'campaign-1', enabled: false });
    const controller = new TeacherGamificationController({ update } as never);

    await controller.update('campaign-1', { enabled: false }, { userId: 'teacher-1' } as never);

    expect(update).toHaveBeenCalledWith('teacher-1', 'campaign-1', { enabled: false });
  });
});
