import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { ComplaintStatus } from '../enums/complaint-status.enum';
import { ComplaintType } from '../enums/complaint-type.enum';

@Entity('complaints')
@Index('IDX_complaints_student_id', ['student_id'])
@Index('IDX_complaints_status', ['status'])
@Index('IDX_complaints_type', ['type'])
@Index('IDX_complaints_created_at', ['created_at'])
@Index('IDX_complaints_ticket_number', ['ticket_number'], { unique: true })
@Index('IDX_complaints_complainant_id', ['complainant_id'])
@Index('IDX_complaints_assigned_agent_id', ['assigned_agent_id'])
export class Complaint {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Legacy student owner; nullable so instructor tickets use complainant_id. */
  @Column({ type: 'uuid', nullable: true, name: 'student_id' })
  student_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User | null;

  @Column({ type: 'uuid', nullable: false, name: 'complainant_id' })
  complainant_id!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'complainant_id' })
  complainant!: User;

  @Column({ type: 'varchar', length: 20, name: 'complainant_role' })
  complainant_role!: 'student' | 'teacher';

  @Column({ type: 'varchar', length: 32, name: 'ticket_number' })
  ticket_number!: string;

  @Column({
    type: 'enum',
    enum: ComplaintType,
    nullable: false,
  })
  type!: ComplaintType;

  @Column({ type: 'uuid', nullable: true, name: 'target_id' })
  target_id!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: false })
  subject!: string;

  @Column({ type: 'text', nullable: false })
  description!: string;

  @Column({
    type: 'enum',
    enum: ComplaintStatus,
    default: ComplaintStatus.NEW,
  })
  status!: ComplaintStatus;

  @Column({ type: 'text', nullable: true, name: 'admin_response' })
  admin_response!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'admin_id' })
  admin_id!: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'admin_id' })
  admin!: User | null;

  @Column({ type: 'timestamp', nullable: true, name: 'responded_at' })
  responded_at!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'assigned_agent_id' })
  assigned_agent_id!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assigned_agent_id' })
  assigned_agent!: User | null;

  @Column({ type: 'timestamp', nullable: true, name: 'first_response_at' })
  first_response_at!: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'first_response_due_at' })
  first_response_due_at!: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'resolution_due_at' })
  resolution_due_at!: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'resolved_at' })
  resolved_at!: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'closed_at' })
  closed_at!: Date | null;

  @Column({ type: 'timestamp', nullable: true, name: 'escalated_at' })
  escalated_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  resolution!: string | null;

  @Column({ type: 'text', nullable: true, name: 'close_reason' })
  close_reason!: string | null;

  @Column({ type: 'int', default: 0, name: 'reopen_count' })
  reopen_count!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @VersionColumn({ name: 'version' })
  version!: number;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
