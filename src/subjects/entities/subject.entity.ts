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
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { SubjectStatus } from './subject-status.enum';

@Entity('subjects')
export class Subject {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index('IDX_subjects_name')
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name_ar!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  description_ar!: string | null;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: false,
    name: 'grade_level',
    default: 'grade_12',
  })
  @Index('IDX_subjects_grade_level')
  grade_level!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  thumbnail!: string | null;

  /**
   * Lifecycle state. Defaults to APPROVED so admin-created subjects and every
   * row predating the ownership migration stay live; teacher-created subjects
   * set PENDING_APPROVAL explicitly in `SubjectsService.createByTeacher`.
   */
  @Column({ type: 'varchar', length: 20, default: SubjectStatus.APPROVED })
  @Index('IDX_subjects_status')
  status!: SubjectStatus;

  /** Owning teacher's `users.id`. NULL means platform-owned (admin-created). */
  @Column({ type: 'uuid', name: 'created_by_teacher_id', nullable: true })
  @Index('IDX_subjects_created_by_teacher_id')
  created_by_teacher_id!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_teacher_id' })
  created_by_teacher?: User | null;

  /** Reason recorded when an admin rejects or suspends the subject. */
  @Column({ type: 'text', name: 'rejection_reason', nullable: true })
  rejection_reason!: string | null;

  @Column({ type: 'uuid', name: 'reviewed_by_admin_id', nullable: true })
  reviewed_by_admin_id!: string | null;

  @Column({ type: 'timestamp', name: 'reviewed_at', nullable: true })
  reviewed_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  // Relations will be added as other entities are created:
  // - OneToMany with Lesson
  // - ManyToMany with TeacherProfile (declared on TeacherProfile via teacher_subjects)
}

