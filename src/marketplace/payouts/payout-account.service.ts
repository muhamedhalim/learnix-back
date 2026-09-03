import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { encryptSecret, resolvePayoutEncryptionKey } from '../../common/utils/secret-box.util';
import { biBody } from '../../i18n/error-translator.util';
import { PayoutAccountVerificationStatus, PayoutRequestStatus } from '../common/enums';
import { payoutAccountInUse } from '../common/errors';
import { MarketplacePayoutAccount, MarketplacePayoutRequest } from './entities';

const OPEN_PAYOUT_STATUSES = [PayoutRequestStatus.REQUESTED, PayoutRequestStatus.APPROVED, PayoutRequestStatus.PROCESSING];

export interface PayoutAccountSummary {
  id: string;
  account_holder_name: string;
  bank_name: string;
  account_identifier_last4: string;
  currency: string;
  country: string;
  verification_status: PayoutAccountVerificationStatus;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreatePayoutAccountInput {
  accountHolderName: string;
  bankName: string;
  accountIdentifier: string;
  currency: string;
  country: string;
}

export interface UpdatePayoutAccountInput {
  accountHolderName?: string;
  bankName?: string;
  accountIdentifier?: string;
}

/**
 * FR-200 – FR-204 (T166). `toSummary()` is the only shape any endpoint ever
 * returns — mirrors `MeetingAccountSummaryDto`'s convention of a mapper
 * that structurally cannot carry the encrypted column, rather than relying
 * on `class-transformer` `@Exclude()` to remember to strip it.
 */
@Injectable()
export class PayoutAccountService {
  constructor(
    @InjectRepository(MarketplacePayoutAccount)
    private readonly accounts: Repository<MarketplacePayoutAccount>,
    @InjectRepository(MarketplacePayoutRequest)
    private readonly payoutRequests: Repository<MarketplacePayoutRequest>,
  ) {}

  public async create(instructorId: string, input: CreatePayoutAccountInput): Promise<PayoutAccountSummary> {
    const account = this.accounts.create({
      instructor_id: instructorId,
      account_holder_name: input.accountHolderName,
      bank_name: input.bankName,
      account_identifier_encrypted: encryptSecret(input.accountIdentifier, resolvePayoutEncryptionKey(), 'PAYOUT_ACCOUNT_ENCRYPTION_KEY'),
      account_identifier_last4: input.accountIdentifier.slice(-4),
      currency: input.currency,
      country: input.country,
      is_default: false,
    });
    const saved = await this.accounts.save(account);
    return this.toSummary(saved);
  }

  public async list(instructorId: string): Promise<PayoutAccountSummary[]> {
    const rows = await this.accounts.find({ where: { instructor_id: instructorId }, order: { created_at: 'DESC' } });
    return rows.map((row) => this.toSummary(row));
  }

  public async update(instructorId: string, id: string, input: UpdatePayoutAccountInput): Promise<PayoutAccountSummary> {
    const account = await this.getOwnedOrThrow(instructorId, id);
    if (input.accountHolderName !== undefined) account.account_holder_name = input.accountHolderName;
    if (input.bankName !== undefined) account.bank_name = input.bankName;
    if (input.accountIdentifier !== undefined) {
      account.account_identifier_encrypted = encryptSecret(input.accountIdentifier, resolvePayoutEncryptionKey(), 'PAYOUT_ACCOUNT_ENCRYPTION_KEY');
      account.account_identifier_last4 = input.accountIdentifier.slice(-4);
      // A changed identifier is a materially different destination — re-verify from scratch.
      account.verification_status = PayoutAccountVerificationStatus.PENDING;
    }
    const saved = await this.accounts.save(account);
    return this.toSummary(saved);
  }

  /** FR-202: exactly one default per currency — the other rows are flipped off in the same transaction as the DB partial-unique index expects. */
  public async setDefault(instructorId: string, id: string): Promise<PayoutAccountSummary> {
    const account = await this.getOwnedOrThrow(instructorId, id);
    await this.accounts.manager.transaction(async (manager) => {
      await manager.update(MarketplacePayoutAccount, { instructor_id: instructorId, currency: account.currency }, { is_default: false });
      await manager.update(MarketplacePayoutAccount, { id: account.id }, { is_default: true });
    });
    return this.toSummary({ ...account, is_default: true });
  }

  /** FR-204: refused while referenced by an in-flight payout request. */
  public async remove(instructorId: string, id: string): Promise<void> {
    const account = await this.getOwnedOrThrow(instructorId, id);
    const inFlight = await this.payoutRequests.exist({
      where: { payout_account_id: id, status: In(OPEN_PAYOUT_STATUSES) },
    });
    if (inFlight) {
      throw payoutAccountInUse();
    }
    await this.accounts.softRemove(account);
  }

  private async getOwnedOrThrow(instructorId: string, id: string): Promise<MarketplacePayoutAccount> {
    const account = await this.accounts.findOne({ where: { id, instructor_id: instructorId } });
    if (!account) {
      throw new NotFoundException(biBody('Payout account not found', 'حساب السحب غير موجود'));
    }
    return account;
  }

  private toSummary(account: MarketplacePayoutAccount): PayoutAccountSummary {
    return {
      id: account.id,
      account_holder_name: account.account_holder_name,
      bank_name: account.bank_name,
      account_identifier_last4: account.account_identifier_last4,
      currency: account.currency,
      country: account.country,
      verification_status: account.verification_status,
      is_default: account.is_default,
      created_at: account.created_at,
      updated_at: account.updated_at,
    };
  }
}
