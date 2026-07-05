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
import { AttendanceCodeAuditAction } from './attendance-code-audit-action.enum';

/**
 * Immutable audit trail for attendance codes. One row per action (generation,
 * redemption, revoke, enable/disable, delete, export). Batch-level actions may
 * omit `code_id` and reference `batch_id` only.
 */
@Entity('attendance_code_audits')
@Index('IDX_code_audits_code_id', ['code_id'])
@Index('IDX_code_audits_batch_id', ['batch_id'])
@Index('IDX_code_audits_action', ['action'])
@Index('IDX_code_audits_created_at', ['created_at'])
export class AttendanceCodeAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'code_id' })
  code_id!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'batch_id' })
  batch_id!: string | null;

  @Column({
    type: 'enum',
    enum: AttendanceCodeAuditAction,
    enumName: 'attendance_code_audit_action_enum',
  })
  action!: AttendanceCodeAuditAction;

  /** Actor who performed the action (null for system/expiry transitions). */
  @Column({ type: 'uuid', nullable: true, name: 'actor_id' })
  actor_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_id' })
  actor!: User | null;

  /** Free-form context (reason, counts, ip, previous state, …). */
  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
