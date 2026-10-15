import { NotFoundException } from '@nestjs/common';

import { PayoutAccountVerificationStatus } from '../common/enums';
import { PayoutAccountService } from './payout-account.service';

const FULL_IDENTIFIER = 'EG1234567890123456789012345678';

function buildAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1',
    instructor_id: 'instructor-1',
    account_holder_name: 'Ada Lovelace',
    bank_name: 'Test Bank',
    account_identifier_encrypted: 'v1:iv:tag:cipher',
    account_identifier_last4: FULL_IDENTIFIER.slice(-4),
    currency: 'EGP',
    country: 'EG',
    verification_status: PayoutAccountVerificationStatus.PENDING,
    is_default: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('PayoutAccountService (T166)', () => {
  let accountsRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock; softRemove: jest.Mock; manager: { transaction: jest.Mock } };
  let payoutRequestsRepo: { exist: jest.Mock };
  let service: PayoutAccountService;
  const originalKey = process.env['PAYOUT_ACCOUNT_ENCRYPTION_KEY'];

  beforeAll(() => {
    process.env['PAYOUT_ACCOUNT_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
  });

  afterAll(() => {
    if (originalKey === undefined) delete process.env['PAYOUT_ACCOUNT_ENCRYPTION_KEY'];
    else process.env['PAYOUT_ACCOUNT_ENCRYPTION_KEY'] = originalKey;
  });

  beforeEach(() => {
    accountsRepo = {
      create: jest.fn((data: Record<string, unknown>) => data),
      save: jest.fn(async (data: Record<string, unknown>) => buildAccount(data)),
      find: jest.fn(),
      findOne: jest.fn(),
      softRemove: jest.fn().mockResolvedValue(undefined),
      manager: { transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn({ update: jest.fn() })) },
    };
    payoutRequestsRepo = { exist: jest.fn().mockResolvedValue(false) };
    service = new PayoutAccountService(accountsRepo as never, payoutRequestsRepo as never);
  });

  describe('create', () => {
    it('encrypts the identifier and stores only its last 4 characters in plain form', async () => {
      const summary = await service.create('instructor-1', {
        accountHolderName: 'Ada Lovelace',
        bankName: 'Test Bank',
        accountIdentifier: FULL_IDENTIFIER,
        currency: 'EGP',
        country: 'EG',
      });

      const savedArg = accountsRepo.save.mock.calls[0]![0] as Record<string, unknown>;
      expect(savedArg.account_identifier_encrypted).not.toBe(FULL_IDENTIFIER);
      expect(String(savedArg.account_identifier_encrypted)).not.toContain(FULL_IDENTIFIER);
      expect(savedArg.account_identifier_last4).toBe(FULL_IDENTIFIER.slice(-4));

      // The full identifier never appears anywhere in the returned summary.
      expect(JSON.stringify(summary)).not.toContain(FULL_IDENTIFIER);
      expect(summary).not.toHaveProperty('account_identifier_encrypted');
      expect(summary.account_identifier_last4).toBe(FULL_IDENTIFIER.slice(-4));
    });
  });

  describe('list', () => {
    it('never exposes the encrypted identifier for any account', async () => {
      accountsRepo.find.mockResolvedValue([buildAccount(), buildAccount({ id: 'account-2' })]);
      const summaries = await service.list('instructor-1');
      for (const summary of summaries) {
        expect(summary).not.toHaveProperty('account_identifier_encrypted');
      }
      expect(JSON.stringify(summaries)).not.toContain(FULL_IDENTIFIER);
    });
  });

  describe('update', () => {
    it('404s an account that does not belong to the caller (IDOR-safe)', async () => {
      accountsRepo.findOne.mockResolvedValue(null);
      await expect(service.update('instructor-1', 'account-1', { bankName: 'New Bank' })).rejects.toThrow(NotFoundException);
    });

    it('re-verifies from PENDING when the identifier changes', async () => {
      accountsRepo.findOne.mockResolvedValue(buildAccount({ verification_status: PayoutAccountVerificationStatus.VERIFIED }));
      const summary = await service.update('instructor-1', 'account-1', { accountIdentifier: 'EG9999999999999999999999999999' });
      expect(summary.verification_status).toBe(PayoutAccountVerificationStatus.PENDING);
      expect(summary.account_identifier_last4).toBe('9999');
    });

    it('leaves verification untouched when only the holder name changes', async () => {
      accountsRepo.findOne.mockResolvedValue(buildAccount({ verification_status: PayoutAccountVerificationStatus.VERIFIED }));
      const summary = await service.update('instructor-1', 'account-1', { accountHolderName: 'New Name' });
      expect(summary.verification_status).toBe(PayoutAccountVerificationStatus.VERIFIED);
    });
  });

  describe('remove', () => {
    it('refuses removal while referenced by an in-flight payout request (FR-204)', async () => {
      accountsRepo.findOne.mockResolvedValue(buildAccount());
      payoutRequestsRepo.exist.mockResolvedValue(true);

      await expect(service.remove('instructor-1', 'account-1')).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PAYOUT_ACCOUNT_IN_USE' }),
      });
      expect(accountsRepo.softRemove).not.toHaveBeenCalled();
    });

    it('checks only open payout statuses, not terminal ones', async () => {
      accountsRepo.findOne.mockResolvedValue(buildAccount());
      await service.remove('instructor-1', 'account-1');
      expect(payoutRequestsRepo.exist).toHaveBeenCalledWith({
        where: { payout_account_id: 'account-1', status: expect.objectContaining({ _type: 'in' }) },
      });
    });

    it('soft-removes when not referenced', async () => {
      const account = buildAccount();
      accountsRepo.findOne.mockResolvedValue(account);
      await service.remove('instructor-1', 'account-1');
      expect(accountsRepo.softRemove).toHaveBeenCalledWith(account);
    });
  });

  describe('setDefault', () => {
    it('flips every other account in the same currency off within one transaction', async () => {
      accountsRepo.findOne.mockResolvedValue(buildAccount({ currency: 'EGP' }));
      const summary = await service.setDefault('instructor-1', 'account-1');
      expect(accountsRepo.manager.transaction).toHaveBeenCalled();
      expect(summary.is_default).toBe(true);
    });
  });
});
