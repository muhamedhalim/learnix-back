import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payment_domain_events')
@Index('UQ_payment_domain_event_dedupe', ['dedupe_key'], { unique: true })
@Index('IDX_payment_domain_events_pending', ['published_at', 'created_at'])
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

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
