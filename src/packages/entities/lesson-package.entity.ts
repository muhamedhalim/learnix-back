import { PackagePurchase } from '../../payments/entities/package-purchase.entity';
import { User } from '../../users/entities/user.entity';
import { LessonPackageItem } from './lesson-package-item.entity';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('lesson_packages')
@Index('IDX_lesson_packages_teacher_id', ['teacher_id'])
@Index('IDX_lesson_packages_is_active', ['is_active'])
@Index('IDX_lesson_packages_price', ['price'])
@Index('IDX_lesson_packages_created_at', ['created_at'])
export class LessonPackage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 255 })
  title!: string;

  @Column({ length: 255 })
  title_ar!: string;

  @Column('text', { nullable: true })
  description!: string | null;

  @Column('text', { nullable: true })
  description_ar!: string | null;

  @Column('uuid')
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column('decimal', { precision: 10, scale: 2 })
  price!: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  original_price!: number | null;

  @Column('boolean', { default: true })
  is_active!: boolean;

  @Column('varchar', { length: 500, nullable: true })
  thumbnail!: string | null;

  @OneToMany(() => LessonPackageItem, (item) => item.package, {
    cascade: true,
  })
  items!: LessonPackageItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;

  @DeleteDateColumn({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  // Phase 4: Payment relations
  @OneToMany(() => PackagePurchase, (purchase) => purchase.package)
  purchases!: PackagePurchase[];
}
