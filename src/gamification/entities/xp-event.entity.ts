import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { XpReason } from './xp-reason.enum';

/**
 * Append-only XP ledger. Every XP award writes one row. Powers windowed
 * leaderboards (weekly / monthly / all-time) via `SUM(amount)` over
 * `occurred_at`, plus audit and anti-abuse forensics. `season_id` is added in a
 * later milestone (nullable, forward-compatible).
 */
@Entity('xp_events')
@Index('IDX_xp_events_user_occurred', ['user_id', 'occurred_at'])
export class XpEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ type: 'enum', enum: XpReason })
  reason!: XpReason;

  /** Optional reference (question_id / exam_id / lesson_id) for the award. */
  @Column({ type: 'uuid', name: 'ref_id', nullable: true })
  ref_id!: string | null;

  @Column({ type: 'timestamptz', name: 'occurred_at' })
  @Index('IDX_xp_events_occurred_at')
  occurred_at!: Date;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
