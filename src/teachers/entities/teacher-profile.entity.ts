import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  OneToOne,
  JoinColumn,
  ManyToMany,
  JoinTable,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Subject } from '../../subjects/entities/subject.entity';

@Entity('teacher_profiles')
export class TeacherProfile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'int', unique: true, nullable: false, name: 'user_id' })
  @Index('IDX_teacher_profiles_user_id')
  user_id!: number;

  @OneToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @ManyToMany(() => Subject)
  @JoinTable({
    name: 'teacher_subjects',
    joinColumn: { name: 'teacher_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'subject_id', referencedColumnName: 'id' },
  })
  subjects!: Subject[];

  @Column({ type: 'text', nullable: false })
  qualifications!: string;

  @Column({ type: 'int', nullable: false, name: 'years_of_experience' })
  years_of_experience!: number;

  @Column({ type: 'text', nullable: true })
  bio!: string | null;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.0 })
  rating!: number;

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
