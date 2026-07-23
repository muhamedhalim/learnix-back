import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payment_audit_logs')
@Index('IDX_payment_audit_resource', ['resource_type', 'resource_id'])
@Index('IDX_payment_audit_actor_created', ['actor_id', 'created_at'])
export class PaymentAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actor_id!: string | null;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 60, name: 'resource_type' })
  resource_type!: string;

  @Column({ type: 'uuid', name: 'resource_id' })
  resource_id!: string;

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ip_address!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
