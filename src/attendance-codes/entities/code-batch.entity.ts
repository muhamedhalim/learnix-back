import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { AttendanceCodeType } from './attendance-code-type.enum';
import { CodeBatchStatus } from './code-batch-status.enum';

/**
 * A batch groups attendance codes generated together in one operation, holding
 * the shared metadata (name, target item, expiry, creator) and the generation
 * progress. Codes are produced asynchronously by a BullMQ worker.
 */
@Entity('code_batches')
@Index('IDX_code_batches_created_by', ['created_by'])
@Index('IDX_code_batches_status', ['status'])
@Index('IDX_code_batches_type_item', ['type', 'item_id'])
export class CodeBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'enum', enum: AttendanceCodeType, enumName: 'code_batches_type_enum' })
  type!: AttendanceCodeType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  /** Requested number of codes (1–100,000). */
  @Column({ type: 'int', name: 'requested_count' })
  requested_count!: number;

  /** Codes successfully generated so far (drives progress %). */
  @Column({ type: 'int', default: 0, name: 'generated_count' })
  generated_count!: number;

  @Column({
    type: 'enum',
    enum: CodeBatchStatus,
    enumName: 'code_batch_status_enum',
    default: CodeBatchStatus.PENDING,
  })
  status!: CodeBatchStatus;

  /** Populated when generation fails, for diagnostics. */
  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator!: User;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
