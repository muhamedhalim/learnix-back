import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { minorUnitsTransformer } from '../money.util';
import { CollectionParty } from './collection-party.enum';
import { ManualPaymentMethodType } from './manual-payment-method-type.enum';

@Entity('manual_payment_methods')
@Index('IDX_manual_payment_methods_enabled_order', ['enabled', 'display_order'])
export class ManualPaymentMethod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  // Deprecated legacy content. New writes use the canonical `name` field.
  @Column({ type: 'varchar', length: 120, name: 'name_ar', nullable: true, select: false })
  name_ar!: string | null;

  @Column({ type: 'varchar', length: 40 })
  type!: ManualPaymentMethodType;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'int', default: 0, name: 'display_order' })
  display_order!: number;

  @Column({ type: 'varchar', length: 160, name: 'recipient_name' })
  recipient_name!: string;

  // Retained for a non-destructive migration only; never used by new writes or student responses.
  @Column({ type: 'jsonb', name: 'destination_details', select: false })
  destination_details!: Record<string, string>;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  configuration!: Record<string, string>;

  @Column({ type: 'text' })
  instructions!: string;

  // Deprecated legacy content. New writes use the canonical `instructions` field.
  @Column({ type: 'text', name: 'instructions_ar', nullable: true, select: false })
  instructions_ar!: string | null;

  @Column({ type: 'text', nullable: true, name: 'internal_notes', select: false })
  internal_notes!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'legacy_content_metadata', select: false })
  legacy_content_metadata!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'qr_file_key' })
  qr_file_key!: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    name: 'minimum_amount_minor',
    transformer: minorUnitsTransformer,
  })
  minimum_amount_minor!: number | null;

  @Column({
    type: 'bigint',
    nullable: true,
    name: 'maximum_amount_minor',
    transformer: minorUnitsTransformer,
  })
  maximum_amount_minor!: number | null;

  @Column({ type: 'char', length: 3, default: 'EGP' })
  currency!: string;

  @Column({ type: 'int', default: 1440, name: 'order_expiration_minutes' })
  order_expiration_minutes!: number;

  @Column({ type: 'boolean', default: true, name: 'proof_required' })
  proof_required!: boolean;

  @Column({ type: 'boolean', default: true, name: 'transaction_reference_required' })
  transaction_reference_required!: boolean;

  @Column({ type: 'jsonb', nullable: true })
  countries!: string[] | null;

  @Column({ type: 'varchar', length: 30, default: CollectionParty.PLATFORM })
  collection_party!: CollectionParty;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @Column({ type: 'uuid', name: 'updated_by' })
  updated_by!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
