import { Reflector } from '@nestjs/core';

import { FINANCE_PERMISSIONS_KEY } from '../decorators/finance-permissions.decorator';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminPaymentsController } from './admin-payments.controller';

/**
 * Every admin route that exposes financial data must declare a finance
 * capability. `@Roles('admin')` alone is not sufficient — `finance_permissions`
 * is the mechanism that lets an organisation give an admin operational access
 * without giving them the money.
 *
 * This reads the metadata the guard reads, so a new route that forgets the
 * decorator fails here rather than shipping unguarded.
 */
describe('admin finance route permissions', () => {
  const reflector = new Reflector();

  const permissionsFor = (
    controller: new (...args: never[]) => object,
    method: string,
  ): string[] | undefined =>
    reflector.getAllAndOverride<string[] | undefined>(FINANCE_PERMISSIONS_KEY, [
      (controller.prototype as Record<string, () => unknown>)[method],
      controller,
    ]);

  const handlersOf = (controller: new (...args: never[]) => object): string[] =>
    Object.getOwnPropertyNames(controller.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        typeof (controller.prototype as Record<string, unknown>)[name] === 'function',
    );

  describe('AdminFinanceController', () => {
    it.each([
      ['listOrders', 'reports.view'],
      ['listRefunds', 'reports.view'],
      ['financeAuditTrail', 'settlements.view'],
      ['financeAuditActions', 'settlements.view'],
      ['listSettlements', 'settlements.view'],
      ['teacherBalances', 'settlements.view'],
      ['settlementDetails', 'settlements.view'],
      ['createSettlement', 'settlements.create'],
      ['approveSettlement', 'settlements.approve'],
      ['paySettlement', 'settlements.pay'],
      ['rejectSettlement', 'settlements.reject'],
      ['cancelSettlement', 'settlements.cancel'],
      ['requestRefund', 'refunds.create'],
      ['processGatewayRefund', 'refunds.process'],
      ['completeRefund', 'refunds.complete'],
      ['reports', 'reports.view'],
      ['exportReports', 'reports.export'],
      ['reconciliation', 'reconciliation.review'],
    ])('%s requires %s', (method, permission) => {
      expect(permissionsFor(AdminFinanceController, method)).toContain(permission);
    });

    it.each([
      ['listMethods', 'reports.view'],
      ['listSubmissions', 'reports.view'],
      ['proof', 'reports.view'],
      ['createMethod', 'refunds.complete'],
      ['updateMethod', 'refunds.complete'],
      ['startReview', 'refunds.complete'],
      ['approveSubmission', 'refunds.complete'],
      ['rejectSubmission', 'refunds.complete'],
      ['cancelSubmission', 'refunds.complete'],
      ['requestInformation', 'refunds.complete'],
    ])('manual payment route %s requires %s', (method, permission) => {
      expect(permissionsFor(AdminFinanceController, method)).toContain(permission);
    });

    it('leaves no route relying on the admin role alone', () => {
      const unguarded = handlersOf(AdminFinanceController).filter(
        (handler) => (permissionsFor(AdminFinanceController, handler)?.length ?? 0) === 0,
      );

      expect(unguarded).toEqual([]);
    });
  });

  describe('AdminPaymentsController', () => {
    it('requires reports.view for every revenue and purchase read', () => {
      for (const handler of handlersOf(AdminPaymentsController)) {
        expect(permissionsFor(AdminPaymentsController, handler)).toContain('reports.view');
      }
    });

    it('applies the requirement at the class level so new routes inherit it', () => {
      expect(
        reflector.get<string[] | undefined>(FINANCE_PERMISSIONS_KEY, AdminPaymentsController),
      ).toContain('reports.view');
    });
  });
});
