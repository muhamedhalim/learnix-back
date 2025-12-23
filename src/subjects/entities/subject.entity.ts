import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';

@Entity('subjects')
export class Subject {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Index('IDX_subjects_title')
  title!: string;

  @Column({ type: 'varchar', length: 255, nullable: false, name: 'title_ar' })
  @Index('IDX_subjects_title_ar')
  title_ar!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true, name: 'description_ar' })
  description_ar!: string | null;

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
