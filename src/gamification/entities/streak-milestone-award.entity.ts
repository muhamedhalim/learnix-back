import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Immutable proof that a student has received a given streak milestone reward. */
@Entity('streak_milestone_awards')
@Unique('UQ_streak_milestone_award_user_days', ['user_id', 'days'])
export class StreakMilestoneAward {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  @Index('IDX_streak_milestone_awards_user_id')
  user_id!: string;

  @Column({ type: 'int' })
  days!: number;

  @CreateDateColumn({ name: 'awarded_at' })
  awarded_at!: Date;
}
