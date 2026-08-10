import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import type { ParentReportPayload } from './parent-report-payload';
import { ParentReportStatus } from './parent-report-status.enum';
import { ParentReportType } from './parent-report-type.enum';

/**
 * One aggregated report, for one student, for one closed period.
 *
 * Note the grain: **per student**, not per guardian. A student with three
 * guardians produces one row here and three rows in `parent_messages`. That
 * split is deliberate — aggregation is expensive and identical for every
 * guardian of the same child, while delivery differs per guardian (language,
 * channel, opt-out). Computing it once and fanning out afterwards is both
 * cheaper and the only way three siblings' parents cannot see three subtly
 * different versions of the same week.
 *
 * The unique constraint on (student, type, start, end) is the report engine's
 * half of the idempotency guarantee: a scheduler that fires twice, or a worker
 * that restarts mid-sweep, re-derives the identical period and loses the race
 * to insert. The delivery half lives in `parent_messages.idempotency_key`,
 * which additionally scopes by guardian. Together they satisfy the required
 * key of (guardian relationship, student, report type, period start, period
 * end) without either table having to know the other's business.
 */
@Entity('parent_reports')
@Unique('UQ_parent_reports_student_type_period', [
  'student_id',
  'report_type',
  'period_start',
  'period_end',
])
@Index('IDX_parent_reports_student', ['student_id'])
@Index('IDX_parent_reports_status', ['status'])
@Index('IDX_parent_reports_type_period', ['report_type', 'period_start'])
export class ParentReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'enum', enum: ParentReportType, name: 'report_type' })
  report_type!: ParentReportType;

  /**
   * Human-readable period identity (`w2026-08-03`, `m2026-07`). Redundant with
   * the boundary columns and kept anyway: it is what appears in job ids and log
   * lines, and reading it beats reconstructing a week from two timestamps.
   */
  @Column({ type: 'varchar', length: 32, name: 'period_key' })
  period_key!: string;

  /** Inclusive lower bound. */
  @Column({ type: 'timestamptz', name: 'period_start' })
  period_start!: Date;

  /** **Exclusive** upper bound — see `report-period.ts` for why. */
  @Column({ type: 'timestamptz', name: 'period_end' })
  period_end!: Date;

  /**
   * The zone whose calendar defined the boundaries. Stored per row rather than
   * read from config at render time so that changing `APP_TIMEZONE` later
   * cannot retroactively relabel reports that were already sent.
   */
  @Column({ type: 'varchar', length: 64, name: 'time_zone' })
  time_zone!: string;

  @Column({
    type: 'enum',
    enum: ParentReportStatus,
    default: ParentReportStatus.PENDING,
  })
  status!: ParentReportStatus;

  /** Counts only — never prose. See `ParentReportPayload`. */
  @Column({ type: 'jsonb', nullable: true })
  payload!: ParentReportPayload | null;

  /** How many guardian messages this report was fanned out to. */
  @Column({ type: 'int', default: 0, name: 'recipient_count' })
  recipient_count!: number;

  @Column({ type: 'timestamptz', nullable: true, name: 'generated_at' })
  generated_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'dispatched_at' })
  dispatched_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
