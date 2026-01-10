import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';
import { LessonPackage } from './lesson-package.entity';
import { Lesson } from '../../lessons/entities/lesson.entity';

@Entity('lesson_package_items')
@Index('IDX_lesson_package_items_package_id', ['package_id'])
@Index('IDX_lesson_package_items_lesson_id', ['lesson_id'])
@Unique('UQ_lesson_package_items_package_lesson', ['package_id', 'lesson_id'])
export class LessonPackageItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  package_id!: string;

  @ManyToOne(() => LessonPackage, (pkg) => pkg.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: LessonPackage;

  @Column('uuid')
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column('int', { default: 0 })
  order_index!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
