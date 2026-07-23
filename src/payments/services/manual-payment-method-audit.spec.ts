import { DataSource } from 'typeorm';

import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { StorageService } from '../../storage/storage.service';
import { ManualPaymentMethod, ManualPaymentMethodType, PaymentAuditLog } from '../entities';
import { PaymentFinalizationService } from './payment-finalization.service';
import { ManualPaymentsService } from './manual-payments.service';

const createDto = {
  name: 'Bank transfer',
  type: ManualPaymentMethodType.BANK_TRANSFER,
  recipient_name: 'Learnix',
  configuration: { bank_name: 'CIB', account_number: '1234-5678' },
  instructions: 'Pay the exact amount.',
  currency: 'EGP',
};

function transactionalDataSource(failAudit = false): {
  dataSource: DataSource;
  methods: ManualPaymentMethod[];
  audits: Record<string, unknown>[];
} {
  const methods: ManualPaymentMethod[] = [];
  const audits: Record<string, unknown>[] = [];
  const dataSource = {
    transaction: async (callback: (manager: Record<string, unknown>) => Promise<unknown>) => {
      const pendingMethods = [...methods];
      const pendingAudits = [...audits];
      const manager = {
        create: (_entity: unknown, value: ManualPaymentMethod) => ({ ...value, id: 'method-1' }),
        findOne: async () => pendingMethods[0] ?? null,
        save: async (_entity: unknown, value: ManualPaymentMethod) => {
          const index = pendingMethods.findIndex((method) => method.id === value.id);
          if (index >= 0) pendingMethods[index] = value;
          else pendingMethods.push(value);
          return value;
        },
        insert: async (entity: unknown, value: Record<string, unknown>) => {
          expect(entity).toBe(PaymentAuditLog);
          if (failAudit) throw new Error('audit write failed');
          pendingAudits.push(value);
        },
      };
      const result = await callback(manager);
      methods.splice(0, methods.length, ...pendingMethods);
      audits.splice(0, audits.length, ...pendingAudits);
      return result;
    },
  } as unknown as DataSource;
  return { dataSource, methods, audits };
}

function serviceFor(dataSource: DataSource): ManualPaymentsService {
  return new ManualPaymentsService(
    {} as never,
    {} as never,
    {} as never,
    dataSource,
    {} as StorageService,
    {} as PaymentFinalizationService,
    {} as DiscountCodesService,
  );
}

describe('ManualPaymentsService method audit transaction', () => {
  it('creates a method and its required audit record atomically', async () => {
    const state = transactionalDataSource();
    await serviceFor(state.dataSource).createMethod(createDto, 'admin-1');

    expect(state.methods).toHaveLength(1);
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: 'manual_payment_method_created',
        resource_id: 'method-1',
        actor_id: 'admin-1',
      }),
    ]);
  });

  it('audits updates, including enable and disable operations', async () => {
    const state = transactionalDataSource();
    const service = serviceFor(state.dataSource);
    await service.createMethod(createDto, 'admin-1');
    await service.updateMethod('method-1', { enabled: false }, 'admin-1');
    await service.updateMethod('method-1', { enabled: true }, 'admin-1');

    expect(state.methods[0]?.enabled).toBe(true);
    expect(state.audits.map((audit) => audit['action'])).toEqual([
      'manual_payment_method_created',
      'manual_payment_method_updated',
      'manual_payment_method_updated',
    ]);
  });

  it('rolls back the method mutation when its mandatory audit write fails', async () => {
    const state = transactionalDataSource(true);
    await expect(serviceFor(state.dataSource).createMethod(createDto, 'admin-1')).rejects.toThrow(
      'audit write failed',
    );
    expect(state.methods).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});
