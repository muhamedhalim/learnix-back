import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { CollectionParty } from './collection-party.enum';
import { ManualPaymentMethodType } from './manual-payment-method-type.enum';

@Entity('manual_payment_methods')
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

  @Column({ type: 'char', length: 3, default: 'EGP' })
  currency!: string;

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
