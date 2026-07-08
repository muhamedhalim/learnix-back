import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from '../../exams/entities/numeric.transformer';
import { User } from '../../users/entities/user.entity';
import { RankTier } from './rank-tier.entity';

/**
 * Cached per-student game state — the single row the profile/leaderboard UI
 * reads. It is a materialized projection kept in sync transactionally by
 * `GamificationService.recordSolve`; the append-only ledgers (`xp_events`,
 * `question_solves`) remain the source of truth for audit/rebuilds.
 */
@Entity('student_game_profiles')
export class StudentGameProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id', unique: true })
  @Index('IDX_student_game_profiles_user_id')
  user_id!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: Relation<User>;

  @Column({ type: 'bigint', default: 0, transformer: numericTransformer })
  @Index('IDX_student_game_profiles_xp')
  xp!: number;

  @Column({ type: 'int', default: 1 })
  level!: number;

  @Column({ type: 'numeric', precision: 8, scale: 2, name: 'global_rating', default: 1200, transformer: numericTransformer })
  @Index('IDX_student_game_profiles_global_rating')
  global_rating!: number;

  @Column({ type: 'int', name: 'current_streak', default: 0 })
  current_streak!: number;

  @Column({ type: 'int', name: 'longest_streak', default: 0 })
  longest_streak!: number;

  /** Date (app TZ) of the last streak-qualifying solve. Null = never. */
  @Column({ type: 'date', name: 'last_active_date', nullable: true })
  last_active_date!: string | null;

  @Column({ type: 'int', name: 'current_combo', default: 0 })
  current_combo!: number;

  @Column({ type: 'int', name: 'longest_combo', default: 0 })
  longest_combo!: number;

  @Column({ type: 'int', name: 'total_solved', default: 0 })
  total_solved!: number;

  @Column({ type: 'int', name: 'total_correct', default: 0 })
  total_correct!: number;

  @Column({ type: 'int', name: 'total_wrong', default: 0 })
  total_wrong!: number;

  @Column({ type: 'bigint', name: 'total_time_ms', default: 0, transformer: numericTransformer })
  total_time_ms!: number;

  @Column({ type: 'uuid', name: 'rank_tier_id', nullable: true })
  rank_tier_id!: string | null;

  @ManyToOne(() => RankTier, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'rank_tier_id' })
  rank_tier!: Relation<RankTier> | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
