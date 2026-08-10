import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';

export interface EducationEntry {
  institution: string;
  degree: string;
  year?: string;
}

export interface CertificateEntry {
  name: string;
  issuer?: string;
  year?: string;
}

@Entity('teacher_profiles')
export class TeacherProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true, nullable: false, name: 'user_id' })
  @Index('IDX_teacher_profiles_user_id')
  user_id!: string;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToMany(() => Subject)
  @JoinTable({
    name: 'teacher_subjects',
    joinColumn: { name: 'teacher_profile_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'subject_id', referencedColumnName: 'id' },
  })
  subjects!: Subject[];

  @Column({ type: 'text', nullable: false })
  qualifications!: string;

  @Column({ type: 'int', nullable: false, name: 'years_of_experience' })
  years_of_experience!: number;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'text', nullable: true, name: 'bio_ar' })
  bio_ar!: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true, name: 'professional_title' })
  professional_title!: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true, name: 'professional_title_ar' })
  professional_title_ar!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  specializations!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  languages!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  skills!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  education!: EducationEntry[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  certificates!: CertificateEntry[];

  /**
   * @deprecated Legacy denormalised rating. No code path has ever written it —
   * `ReviewsService` stores ratings in `teacher_reviews` and the old
   * `TeachersService.updateTeacherRating` had no caller — so it reads `0.00` for
   * every teacher. Ratings are derived from approved reviews on read via
   * `ReviewsService.getTeacherRatingsBatch`. Kept so existing rows and the
   * column-level schema stay untouched; do not read it.
   */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating!: number;

  /** @deprecated Companion of the legacy {@link rating} column; always `0`. */
  @Column({ type: 'int', default: 0, name: 'total_ratings' })
  total_ratings!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  // Relations will be added as we build more features:
  // - OneToMany with Lesson
  // - OneToMany with TeacherRating
}
