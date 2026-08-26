import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { FINANCE_PERMISSIONS_KEY } from '../decorators/finance-permissions.decorator';
import { FINANCE_PERMISSIONS, type FinancePermission } from '../finance-permissions';
import { FinancePermissionsGuard } from '../guards/finance-permissions.guard';
import { AdminFinanceController } from './admin-finance.controller';

/**
 * AUD-032 regression coverage: manual-payment administration must be its own
 * capability, and must not be reachable with refund permissions alone.
 *
 * Route-level assertions read the decorator metadata Nest itself resolves, so
 * they fail if anyone rebinds a route back to `refunds.complete`.
 */
function permissionsFor(method: keyof AdminFinanceController): string[] {
  return (
    (Reflect.getMetadata(
      FINANCE_PERMISSIONS_KEY,
      AdminFinanceController.prototype[method] as never,
    ) as string[] | undefined) ?? []
  );
}

describe('AdminFinanceController manual-payment permissions', () => {
  // Route→permission bindings are asserted once, in
  // `admin-finance.permissions.spec.ts`. What this file adds is the separation
  // property itself: that approval, queue work and method configuration are
  // three distinct grants, and that none of them is reachable with refund
  // permissions.
  describe('capability separation', () => {
    it('review, approve and manage_methods are three different grants', () => {
      const review = permissionsFor('startReview');
      const approve = permissionsFor('approveSubmission');
      const manage = permissionsFor('createMethod');

      expect(review).not.toEqual(approve);
      expect(approve).not.toEqual(manage);
      expect(review).not.toEqual(manage);
    });

    it('reads stay on reports.view — the split did not tighten read access', () => {
      for (const method of ['listMethods', 'listSubmissions', 'proof'] as const) {
        expect(permissionsFor(method)).toEqual(['reports.view']);
      }
    });
  });

  describe('permission catalogue', () => {
    it('registers the three manual-payment capabilities', () => {
      expect(FINANCE_PERMISSIONS).toEqual(
        expect.arrayContaining([
          'manual_payments.review',
          'manual_payments.approve',
          'manual_payments.manage_methods',
        ]),
      );
    });

    it('contains no duplicates', () => {
      expect(new Set(FINANCE_PERMISSIONS).size).toBe(FINANCE_PERMISSIONS.length);
    });
  });

  describe('enforcement through FinancePermissionsGuard', () => {
    const reflector = { getAllAndOverride: jest.fn() };
    const users = { findOne: jest.fn() };

    const context = (userId = 'admin-1') =>
      ({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => ({ user: { userId } }) }),
      }) as unknown as ExecutionContext;

    function guardFor(required: FinancePermission[], granted: FinancePermission[]) {
      reflector.getAllAndOverride.mockReturnValue(required);
      users.findOne.mockResolvedValue({
        id: 'admin-1',
        role: 'admin',
        finance_permissions: granted,
      });
      return new FinancePermissionsGuard(reflector as never, users as never);
    }

    beforeEach(() => jest.clearAllMocks());

    it('an authorized reviewer succeeds', async () => {
      const guard = guardFor(['manual_payments.review'], ['manual_payments.review']);
      await expect(guard.canActivate(context())).resolves.toBe(true);
    });

    it('refund permissions alone no longer unlock manual-payment approval', async () => {
      const guard = guardFor(
        ['manual_payments.approve'],
        ['refunds.create', 'refunds.process', 'refunds.complete'],
      );
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a reviewer cannot approve — review and approve are distinct grants', async () => {
      const guard = guardFor(['manual_payments.approve'], ['manual_payments.review']);
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a manual-payment reviewer gains no refund-completion power', async () => {
      const guard = guardFor(
        ['refunds.complete'],
        ['manual_payments.review', 'manual_payments.approve', 'manual_payments.manage_methods'],
      );
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('method configuration is not implied by queue permissions', async () => {
      const guard = guardFor(
        ['manual_payments.manage_methods'],
        ['manual_payments.review', 'manual_payments.approve'],
      );
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a non-admin holding the permission on a corrupted row is still refused', async () => {
      reflector.getAllAndOverride.mockReturnValue(['manual_payments.approve']);
      users.findOne.mockResolvedValue({
        id: 'call-center-1',
        role: 'call_center',
        finance_permissions: ['manual_payments.approve'],
      });
      const guard = new FinancePermissionsGuard(reflector as never, users as never);
      await expect(guard.canActivate(context('call-center-1'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('an unauthenticated caller is refused rather than defaulting open', async () => {
      reflector.getAllAndOverride.mockReturnValue(['manual_payments.approve']);
      users.findOne.mockResolvedValue(null);
      const guard = new FinancePermissionsGuard(reflector as never, users as never);
      await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
