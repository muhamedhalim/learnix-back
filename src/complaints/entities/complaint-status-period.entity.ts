import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { ComplaintStatus } from '../enums/complaint-status.enum';
import { Complaint } from './complaint.entity';

/**
 * Immutable lifecycle intervals. Phase 7 reporting can calculate time in a
 * status without reinterpreting audit messages or overwriting historical data.
 */
@Entity('complaint_status_periods')
@Index('IDX_complaint_status_periods_complaint_started_at', ['complaint_id', 'started_at'])
export class ComplaintStatusPeriod {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'complaint_id' })
  complaint_id!: string;

  @ManyToOne(() => Complaint, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'complaint_id' })
  complaint!: Complaint;

  @Column({ type: 'enum', enum: ComplaintStatus })
  status!: ComplaintStatus;

  @Column({ type: 'timestamp', name: 'started_at' })
  started_at!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'ended_at' })
  ended_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
