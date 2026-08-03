import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Server-side timestamp for the last time a student was served a question. */
@Entity('practice_question_serves')
@Unique('UQ_practice_question_serve_user_question', ['user_id', 'question_id'])
export class PracticeQuestionServe {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  @Index('IDX_practice_question_serves_user_id')
  user_id!: string;

  @Column({ type: 'uuid', name: 'question_id' })
  question_id!: string;

  @Column({ type: 'timestamptz', name: 'served_at' })
  served_at!: Date;
}
