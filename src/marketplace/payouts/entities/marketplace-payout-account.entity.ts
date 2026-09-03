import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { PayoutAccountVerificationStatus } from '../../common/enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';

/**
 * An instructor's bank destination for manual payouts (FR-200 – FR-204).
 * `account_identifier_encrypted` is encrypted via the existing
 * `common/utils/secret-box.util.ts`; only `account_identifier_last4` is
 * ever returned by any endpoint (FR-203).
 */
@Entity('marketplace_payout_accounts')
@Index('UQ_mp_payout_accounts_default', ['instructor_id', 'currency'], {
  unique: true,
  where: '"is_default" = true AND "deleted_at" IS NULL',
})
export class MarketplacePayoutAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'instructor_id' })
  instructor_id!: string;

  @ManyToOne(() => MarketplaceInstructor, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'instructor_id' })
  instructor!: MarketplaceInstructor;

  @Column({ type: 'varchar', length: 200, name: 'account_holder_name' })
  account_holder_name!: string;

  @Column({ type: 'varchar', length: 200, name: 'bank_name' })
  bank_name!: string;

  @Column({ type: 'text', name: 'account_identifier_encrypted' })
  account_identifier_encrypted!: string;

  @Column({ type: 'varchar', length: 4, name: 'account_identifier_last4' })
  account_identifier_last4!: string;

  @Column({ type: 'char', length: 3 })
  currency!: string;

  @Column({ type: 'char', length: 2 })
  country!: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: PayoutAccountVerificationStatus.PENDING,
    name: 'verification_status',
  })
  verification_status!: PayoutAccountVerificationStatus;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  is_default!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deleted_at!: Date | null;
}
