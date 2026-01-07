import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { ReportType } from './report-type.enum';
import { ReportStatus } from './report-status.enum';
import { FileFormat } from './file-format.enum';

export interface ReportFilters {
  startDate?: string;
  endDate?: string;
  studentIds?: number[];
  teacherIds?: number[];
  teacherId?: number;
  subjectId?: number;
  examIds?: number[];
  paymentMethod?: string;
}

@Entity('reports')
@Index('IDX_reports_status', ['status'])
@Index('IDX_reports_generated_by', ['generated_by'])
@Index('IDX_reports_created_at', ['created_at'])
@Index('IDX_reports_type_status', ['type', 'status'])
export class Report {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'enum', enum: ReportType })
  type!: ReportType;

  @Column({
    type: 'enum',
    enum: ReportStatus,
    default: ReportStatus.PENDING,
  })
  status!: ReportStatus;

  @Column({ type: 'jsonb', nullable: true })
  filters!: ReportFilters | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'file_path' })
  file_path!: string | null;

  @Column({ type: 'enum', enum: FileFormat, name: 'file_format' })
  file_format!: FileFormat;

  @Column({ type: 'int', name: 'generated_by' })
  generated_by!: number;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'generated_by' })
  generator!: User;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @Column({ type: 'timestamp', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @Column({ type: 'int', nullable: true, name: 'row_count' })
  row_count!: number | null;

  @Column({ type: 'bigint', nullable: true, name: 'file_size' })
  file_size!: number | null;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
