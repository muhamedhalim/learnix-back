import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

@Entity('audit_logs')
@Index('IDX_audit_logs_admin_id', ['admin_id'])
@Index('IDX_audit_logs_action', ['action'])
@Index('IDX_audit_logs_target_type', ['target_type'])
@Index('IDX_audit_logs_created_at', ['created_at'])
@Index('IDX_audit_logs_target_created', ['target_type', 'target_id', 'created_at'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'admin_id' })
  admin_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'admin_id' })
  admin!: User;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 50, name: 'target_type' })
  target_type!: string;

  @Column({ type: 'uuid', nullable: true, name: 'target_id' })
  target_id!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'target_name' })
  target_name!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ip_address!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
