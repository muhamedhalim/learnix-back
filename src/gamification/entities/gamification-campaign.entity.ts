import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * DEF-018: a teacher-scoped, time-boxed XP bonus for correct first-attempt
 * practice solves on questions belonging to one lesson the teacher owns.
 * `bonus_xp` is capped (see `CreateGamificationCampaignDto`) well below the
 * platform's own per-question XP range so one teacher's campaign can never
 * dwarf platform-wide scoring. Folded into the SAME `xp_events`/
 * `question_solves` write as the base award inside `GamificationService
 * .recordSolve`, so it inherits that transaction's existing
 * one-row-per-(user,question) idempotency guard for free — no separate
 * duplicate-award tracking needed.
 */
@Entity('gamification_campaigns')
@Index('IDX_gamification_campaigns_lesson_active', ['lesson_id', 'enabled'])
export class GamificationCampaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'teacher_id' })
  @Index('IDX_gamification_campaigns_teacher_id')
  teacher_id!: string;

  @Column({ type: 'uuid', name: 'lesson_id' })
  lesson_id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'int', name: 'bonus_xp' })
  bonus_xp!: number;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'timestamptz', name: 'start_at' })
  start_at!: Date;

  /** Open-ended when null. */
  @Column({ type: 'timestamptz', name: 'end_at', nullable: true })
  end_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
