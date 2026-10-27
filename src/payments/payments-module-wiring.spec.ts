import 'reflect-metadata';

import { CartModule } from '../cart/cart.module';
import { DiscountCodesModule } from '../discount-codes/discount-codes.module';
import { DiscountCodesService } from '../discount-codes/discount-codes.service';
import { PaymentsModule } from './payments.module';
import { FinancialReportsService } from './services/financial-reports.service';
import { ManualPaymentsService } from './services/manual-payments.service';
import { PaymentOperationsService } from './services/payment-operations.service';
import { PaymentsService } from './services/payments.service';

/**
 * Characterizes the module/DI wiring that previously used `forwardRef` between payments,
 * discount-codes and cart. None of those edges is a real cycle: DiscountCodesModule and
 * DiscountCodesService have no path back to payments services, and PaymentsModule does not import
 * CartModule. These assertions fail if a `forwardRef` wrapper is reintroduced or if a file-level
 * import cycle makes a constructor parameter type `undefined` at decoration time.
 */
const isForwardRef = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'forwardRef' in value;

const imports = (module: object): unknown[] =>
  (Reflect.getMetadata('imports', module) as unknown[] | undefined) ?? [];

describe('payments module wiring', () => {
  it('imports DiscountCodesModule directly, not through forwardRef', () => {
    const found = imports(PaymentsModule).filter((entry) => entry === DiscountCodesModule);
    expect(found).toHaveLength(1);
  });

  it('keeps the remaining forwardRef limited to the NotificationsModule edge (real cycle, Phase 4)', () => {
    const wrapped = imports(PaymentsModule).filter(isForwardRef);
    expect(wrapped).toHaveLength(1);
    expect((wrapped[0] as { forwardRef: () => { name: string } }).forwardRef().name).toBe(
      'NotificationsModule',
    );
  });

  it('lets CartModule import PaymentsModule directly', () => {
    expect(imports(CartModule)).toContain(PaymentsModule);
    expect(imports(CartModule).some(isForwardRef)).toBe(false);
  });

  it.each([
    ['PaymentsService', PaymentsService],
    ['ManualPaymentsService', ManualPaymentsService],
  ])('%s resolves DiscountCodesService as a plain constructor dependency', (_name, service) => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', service) as unknown[];
    expect(paramTypes).toContain(DiscountCodesService);
    expect(paramTypes.every((type) => type !== undefined)).toBe(true);
    // `@Inject(...)` / `@InjectRepository(...)` tokens are recorded under `self:paramtypes`.
    const injected = (Reflect.getMetadata('self:paramtypes', service) ?? []) as Array<{
      param: unknown;
    }>;
    expect(injected.some((entry) => isForwardRef(entry.param))).toBe(false);
  });

  it('no longer exposes the unused legacy financial report', () => {
    expect('legacyFinancialReport' in PaymentOperationsService.prototype).toBe(false);
  });

  describe('financial reporting split (SOLID Phase 2)', () => {
    const reportMethods = [
      'reconciliationReport',
      'dashboardFinancialSnapshot',
      'financialReport',
      'financialReportCsv',
      'reportReconciliationWarnings',
    ];

    it('provides and exports FinancialReportsService from PaymentsModule', () => {
      const providers = Reflect.getMetadata('providers', PaymentsModule) as unknown[];
      const exported = Reflect.getMetadata('exports', PaymentsModule) as unknown[];
      expect(providers).toContain(FinancialReportsService);
      expect(exported).toContain(FinancialReportsService);
    });

    it('owns every reporting method, and PaymentOperationsService no longer has them', () => {
      for (const method of reportMethods) {
        expect(
          typeof FinancialReportsService.prototype[method as keyof FinancialReportsService],
        ).toBe('function');
        expect(method in PaymentOperationsService.prototype).toBe(false);
      }
    });
  });
});
