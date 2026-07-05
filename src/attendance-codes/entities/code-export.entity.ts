import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { CodeExportFormat } from './code-export-format.enum';
import { CodeExportStatus } from './code-export-status.enum';
import { PdfLayout } from './pdf-layout.enum';

/**
 * An asynchronous export job. The requested filter is captured so the worker can
 * stream matching codes into a file (CSV/Excel/PDF/JSON/QR) off the request path.
 * The generated file is cached on disk until {@link expires_at}, after which the
 * cleanup routine removes it.
 */
@Entity('code_exports')
@Index('IDX_code_exports_created_by', ['created_by'])
@Index('IDX_code_exports_status', ['status'])
@Index('IDX_code_exports_batch_id', ['batch_id'])
@Index('IDX_code_exports_expires_at', ['expires_at'])
export class CodeExport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: CodeExportFormat,
    enumName: 'code_export_format_enum',
  })
  format!: CodeExportFormat;

  /** Print layout (PDF/QR only; null for data exports). */
  @Column({
    type: 'enum',
    enum: PdfLayout,
    enumName: 'code_export_pdf_layout_enum',
    nullable: true,
  })
  layout!: PdfLayout | null;

  @Column({
    type: 'enum',
    enum: CodeExportStatus,
    enumName: 'code_export_status_enum',
    default: CodeExportStatus.PENDING,
  })
  status!: CodeExportStatus;

  /** 0–100, updated as the file is streamed. */
  @Column({ type: 'int', default: 0 })
  progress!: number;

  /** Serialized code filter used to select rows (see ListCodesQueryDto). */
  @Column({ type: 'jsonb', nullable: true })
  filters!: Record<string, unknown> | null;

  /** Denormalized for convenient scoping/listing; null for filter-only exports. */
  @Column({ type: 'uuid', nullable: true, name: 'batch_id' })
  batch_id!: string | null;

  /** Number of codes written (set on completion). */
  @Column({ type: 'int', nullable: true, name: 'total_count' })
  total_count!: number | null;

  /** Download file name presented to the client. */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'file_name' })
  file_name!: string | null;

  /** Absolute path on disk (internal; never exposed to clients). */
  @Column({ type: 'text', nullable: true, name: 'file_path' })
  file_path!: string | null;

  @Column({ type: 'bigint', nullable: true, name: 'file_size' })
  file_size!: string | null;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  /** When the cached file becomes eligible for cleanup. */
  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator!: User;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
