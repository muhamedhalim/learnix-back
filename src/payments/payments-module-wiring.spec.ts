import 'reflect-metadata';

import { AnalyticsModule } from '../analytics/analytics.module';
import { AttendanceCodesModule } from '../attendance-codes/attendance-codes.module';
import { BulkOperationsModule } from '../bulk-operations/bulk-operations.module';
import { CartModule } from '../cart/cart.module';
import { ApplicationCacheModule } from '../common/cache/application-cache.module';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { DistributedSingleFlightService } from '../common/cache/distributed-single-flight.service';
import { DiscountCodesModule } from '../discount-codes/discount-codes.module';
import { DiscountCodesService } from '../discount-codes/discount-codes.service';
import { AdminNotificationsApiModule } from '../notifications/admin-notifications-api.module';
import { AdminNotificationsController } from '../notifications/controllers';
import { NotificationsModule } from '../notifications/notifications.module';
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

  it('imports NotificationsModule directly: the Payments → Notifications → … cycle is gone', () => {
    expect(imports(PaymentsModule).filter(isForwardRef)).toHaveLength(0);
    expect(imports(PaymentsModule)).toContain(NotificationsModule);
  });

  describe('former Payments → Notifications → BulkOperations → AttendanceCodes cycle (SOLID Phase 4)', () => {
    it('has no forwardRef left on any edge of the chain', () => {
      for (const module of [
        PaymentsModule,
        NotificationsModule,
        BulkOperationsModule,
        AttendanceCodesModule,
      ]) {
        expect(imports(module).filter(isForwardRef)).toHaveLength(0);
      }
    });

    it('NotificationsModule no longer depends on BulkOperationsModule or hosts the bulk-using controller', () => {
      expect(imports(NotificationsModule)).not.toContain(BulkOperationsModule);
      expect(Reflect.getMetadata('controllers', NotificationsModule)).not.toContain(
        AdminNotificationsController,
      );
    });

    it('AdminNotificationsApiModule composes both and owns the admin notifications controller', () => {
      expect(imports(AdminNotificationsApiModule)).toEqual(
        expect.arrayContaining([NotificationsModule, BulkOperationsModule]),
      );
      expect(Reflect.getMetadata('controllers', AdminNotificationsApiModule)).toEqual([
        AdminNotificationsController,
      ]);
    });

    it('BulkOperationsModule and AttendanceCodesModule import their dependencies directly', () => {
      expect(imports(BulkOperationsModule)).toContain(AttendanceCodesModule);
      expect(imports(AttendanceCodesModule)).toContain(PaymentsModule);
    });
  });

  it('lets the cache live in ApplicationCacheModule instead of AnalyticsModule', () => {
    const provided = Reflect.getMetadata('providers', ApplicationCacheModule) as unknown[];
    expect(provided).toEqual(
      expect.arrayContaining([ApplicationCacheService, DistributedSingleFlightService]),
    );
    expect(Reflect.getMetadata('providers', AnalyticsModule)).not.toContain(
      ApplicationCacheService,
    );
    expect(Reflect.getMetadata('exports', AnalyticsModule)).not.toContain(
      DistributedSingleFlightService,
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
