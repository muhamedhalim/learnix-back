import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { LessonPackage } from '../../packages/entities/lesson-package.entity';
import { User } from '../../users/entities/user.entity';
import { CertificateStatus } from './certificate-status.enum';

/**
 * An issued course-completion certificate.
 *
 * Student/course/teacher names are snapshotted at issue time so a certificate
 * remains a stable historical record even if the underlying names later change.
 * One certificate per (student, course) — enforced by the unique constraint.
 */
@Entity('certificates')
@Unique('UQ_certificate_student_package', ['student_id', 'package_id'])
@Index('IDX_certificates_student_id', ['student_id'])
@Index('IDX_certificates_package_id', ['package_id'])
@Index('IDX_certificates_verification_code', ['verification_code'], { unique: true })
@Index('IDX_certificates_number', ['certificate_number'], { unique: true })
export class Certificate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40, name: 'certificate_number' })
  certificate_number!: string;

  @Column({ type: 'varchar', length: 40, name: 'verification_code' })
  verification_code!: string;

  @Column({ type: 'uuid', name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'uuid', name: 'package_id' })
  package_id!: string;

  @ManyToOne(() => LessonPackage, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'package_id' })
  package!: LessonPackage;

  @Column({ type: 'varchar', length: 200, name: 'student_name' })
  student_name!: string;

  @Column({ type: 'varchar', length: 200, name: 'course_title' })
  course_title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'teacher_name' })
  teacher_name!: string | null;

  @Column({ type: 'int', default: 100, name: 'completion_percentage' })
  completion_percentage!: number;

  @Column({ type: 'uuid', nullable: true, name: 'template_id' })
  template_id!: string | null;

  @Column({
    type: 'enum',
    enum: CertificateStatus,
    default: CertificateStatus.ISSUED,
  })
  status!: CertificateStatus;

  @Column({ type: 'timestamptz', name: 'issued_at' })
  issued_at!: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
