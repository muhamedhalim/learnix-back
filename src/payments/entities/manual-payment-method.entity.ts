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

@Entity('manual_payment_methods')
@Index('IDX_manual_payment_methods_enabled_order', ['enabled', 'display_order'])
export class ManualPaymentMethod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'varchar', length: 120, name: 'name_ar' })
  name_ar!: string;

  @Column({ type: 'varchar', length: 40 })
  type!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'int', default: 0, name: 'display_order' })
  display_order!: number;

  @Column({ type: 'varchar', length: 160, name: 'recipient_name' })
  recipient_name!: string;

  @Column({ type: 'jsonb', name: 'destination_details' })
  destination_details!: Record<string, string>;

  @Column({ type: 'text' })
  instructions!: string;

  @Column({ type: 'text', name: 'instructions_ar' })
  instructions_ar!: string;

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

  @Column({ type: 'boolean', default: true, name: 'reference_required' })
  reference_required!: boolean;

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
