import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('payment_domain_events')
@Index('UQ_payment_domain_event_dedupe', ['dedupe_key'], { unique: true })
@Index('IDX_payment_domain_events_pending', ['published_at', 'created_at'])
@Index('IDX_payment_domain_events_lease', ['status', 'next_retry_at', 'lease_expires_at'])
export class PaymentDomainEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100, name: 'event_name' })
  event_name!: string;

  @Column({ type: 'varchar', length: 180, name: 'dedupe_key' })
  dedupe_key!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'timestamptz', nullable: true, name: 'published_at' })
  published_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  last_error!: string | null;

  @Column({ type: 'varchar', length: 30, default: 'pending' })
  status!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'lease_token' })
  lease_token!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'claimed_by' })
  claimed_by!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'claimed_at' })
  claimed_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'lease_expires_at' })
  lease_expires_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'next_retry_at' })
  next_retry_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'failed_at' })
  failed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
