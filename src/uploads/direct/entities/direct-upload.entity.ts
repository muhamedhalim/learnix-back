import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type DirectUploadMode = 'single' | 'multipart';
export type DirectUploadStatus = 'initiated' | 'completed' | 'aborted' | 'failed';

/** Browser-to-S3 upload session (see migration 2205700000000). */
@Entity('direct_uploads')
@Index('IDX_direct_uploads_user_status', ['user_id', 'status'])
export class DirectUpload {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @Column({ type: 'varchar', length: 40 })
  purpose!: string;

  @Column({ type: 'varchar', length: 255 })
  bucket!: string;

  @Column({ type: 'varchar', length: 500, name: 'object_key' })
  object_key!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  original_name!: string;

  @Column({ type: 'varchar', length: 150, name: 'content_type' })
  content_type!: string;

  /** Bytes. Stored as bigint (20 GB videos exceed int4); safe as a JS number below 2^53. */
  @Column({
    type: 'bigint',
    name: 'declared_size',
    transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) },
  })
  declared_size!: number;

  @Column({ type: 'varchar', length: 12 })
  mode!: DirectUploadMode;

  @Column({ type: 'varchar', length: 1024, nullable: true, name: 'multipart_upload_id' })
  multipart_upload_id!: string | null;

  @Column({ type: 'int', nullable: true, name: 'part_size' })
  part_size!: number | null;

  @Column({ type: 'varchar', length: 12, default: 'initiated' })
  status!: DirectUploadStatus;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'failure_reason' })
  failure_reason!: string | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completed_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
