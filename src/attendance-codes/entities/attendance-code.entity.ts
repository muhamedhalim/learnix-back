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
import { CollectionParty } from '../../payments/entities/collection-party.enum';
import { minorUnitsTransformer } from '../../payments/money.util';
import { AttendanceCodeStatus } from './attendance-code-status.enum';
import { AttendanceCodeType } from './attendance-code-type.enum';
import { CodeBatch } from './code-batch.entity';

@Entity('attendance_codes')
@Index('IDX_attendance_codes_code', ['code'], { unique: true })
@Index('IDX_attendance_codes_used', ['is_used'])
@Index('IDX_attendance_codes_expires', ['expires_at'])
@Index('IDX_attendance_codes_type_item', ['type', 'item_id'])
@Index('IDX_attendance_codes_status', ['status'])
@Index('IDX_attendance_codes_batch_id', ['batch_id'])
@Index('UQ_attendance_codes_lookup_hash', ['lookup_hash'], {
  unique: true,
  where: '"lookup_hash" IS NOT NULL',
})
export class AttendanceCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16, unique: true })
  code!: string;

  @Column({ type: 'char', length: 64, nullable: true, name: 'lookup_hash' })
  lookup_hash!: string | null;

  @Column({ type: 'enum', enum: AttendanceCodeType })
  type!: AttendanceCodeType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @Column({ type: 'uuid', nullable: true, name: 'teacher_id' })
  teacher_id!: string | null;

  @Column({
    type: 'bigint',
    nullable: true,
    name: 'face_value_minor',
    transformer: minorUnitsTransformer,
  })
  face_value_minor!: number | null;

  @Column({ type: 'int', nullable: true, name: 'platform_commission_bps' })
  platform_commission_bps!: number | null;

  @Column({ type: 'char', length: 3, default: 'EGP' })
  currency!: string;

  /** The batch this code was generated in (nullable for legacy codes). */
  @Column({ type: 'uuid', nullable: true, name: 'batch_id' })
  batch_id!: string | null;

  @ManyToOne(() => CodeBatch, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'batch_id' })
  batch!: CodeBatch | null;

  /** Canonical lifecycle state (see AttendanceCodeStatus). */
  @Column({
    type: 'enum',
    enum: AttendanceCodeStatus,
    enumName: 'attendance_code_status_enum',
    default: AttendanceCodeStatus.UNUSED,
  })
  status!: AttendanceCodeStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'valid_from' })
  valid_from!: Date | null;

  @Column({ type: 'int', default: 1, name: 'maximum_redemptions' })
  maximum_redemptions!: number;

  @Column({ type: 'int', default: 0, name: 'redemption_count' })
  redemption_count!: number;

  @Column({ type: 'varchar', length: 30, default: CollectionParty.UNKNOWN })
  collection_party!: CollectionParty;

  @Column({ type: 'varchar', length: 120, nullable: true, name: 'assigned_party' })
  assigned_party!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_student_id' })
  assigned_student_id!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'redeemed_order_id' })
  redeemed_order_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false, name: 'is_used' })
  is_used!: boolean;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  is_active!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'used_by' })
  used_by!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'used_by' })
  user!: User | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'used_at' })
  used_at!: Date | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator!: User;

  /** Revoke metadata (set when status → REVOKED). */
  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'revoked_by' })
  revoked_by!: string | null;

  @Column({ type: 'text', nullable: true, name: 'revoke_reason' })
  revoke_reason!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
