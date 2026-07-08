import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Difficulty } from '../../exams/entities/difficulty.enum';

/**
 * Groups a run of practice solves so combo can span multiple questions and
 * per-session velocity (anti-cheat) can be evaluated. A session is opened when
 * the student starts practicing and closed on exit/idle.
 */
@Entity('practice_sessions')
export class PracticeSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  @Index('IDX_practice_sessions_user_id')
  user_id!: string;

  @Column({ type: 'uuid', name: 'subject_id', nullable: true })
  subject_id!: string | null;

  @Column({ type: 'enum', enum: Difficulty, nullable: true })
  difficulty!: Difficulty | null;

  @Column({ type: 'int', name: 'answered_count', default: 0 })
  answered_count!: number;

  @Column({ type: 'int', name: 'correct_count', default: 0 })
  correct_count!: number;

  @Column({ type: 'int', name: 'combo_peak', default: 0 })
  combo_peak!: number;

  @Column({ type: 'timestamptz', name: 'ended_at', nullable: true })
  ended_at!: Date | null;

  @CreateDateColumn({ name: 'started_at' })
  started_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
