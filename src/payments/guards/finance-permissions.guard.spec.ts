import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { FinancePermissionsGuard } from './finance-permissions.guard';

describe('FinancePermissionsGuard', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };
  const users = { findOne: jest.fn() };
  const context = (userId = 'admin-1', principal: Record<string, unknown> = {}) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ user: { userId, ...principal } }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => jest.clearAllMocks());

  it('allows only explicitly persisted permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['settlements.pay']);
    users.findOne.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      finance_permissions: ['settlements.pay'],
    });
    const guard = new FinancePermissionsGuard(reflector as never, users as never);
    await expect(guard.canActivate(context())).resolves.toBe(true);
  });

  it('rejects an administrator lacking the requested permission', async () => {
    reflector.getAllAndOverride.mockReturnValue(['refunds.process']);
    users.findOne.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      finance_permissions: ['refunds.create'],
    });
    const guard = new FinancePermissionsGuard(reflector as never, users as never);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-admin roles even if a corrupted row contains finance permissions', async () => {
    reflector.getAllAndOverride.mockReturnValue(['reports.view']);
    users.findOne.mockResolvedValue({
      id: 'teacher-1',
      role: 'teacher',
      finance_permissions: ['reports.view'],
    });
    const guard = new FinancePermissionsGuard(reflector as never, users as never);
    await expect(guard.canActivate(context('teacher-1'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('principal-sourced permissions', () => {
    const guard = () => new FinancePermissionsGuard(reflector as never, users as never);

    it('allows from the principal without any repository call', async () => {
      reflector.getAllAndOverride.mockReturnValue(['settlements.pay']);
      await expect(
        guard().canActivate(
          context('admin-1', { role: 'admin', financePermissions: ['settlements.pay'] }),
        ),
      ).resolves.toBe(true);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('denies a missing permission without any repository call', async () => {
      reflector.getAllAndOverride.mockReturnValue(['refunds.process']);
      await expect(
        guard().canActivate(
          context('admin-1', { role: 'admin', financePermissions: ['refunds.create'] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('denies a non-admin principal that carries permissions', async () => {
      reflector.getAllAndOverride.mockReturnValue(['reports.view']);
      await expect(
        guard().canActivate(
          context('teacher-1', { role: 'teacher', financePermissions: ['reports.view'] }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('denies an admin principal with an empty permission list', async () => {
      reflector.getAllAndOverride.mockReturnValue(['reports.view']);
      await expect(
        guard().canActivate(context('admin-1', { role: 'admin', financePermissions: [] })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('still denies when the user id is missing', async () => {
      reflector.getAllAndOverride.mockReturnValue(['reports.view']);
      await expect(guard().canActivate(context(''))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
