import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

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

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;

  // Relations will be added as other entities are created:
  // - OneToMany with Lesson
  // - ManyToMany with TeacherProfile
}
