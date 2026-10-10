import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type VideoAssetStatus = 'uploaded' | 'processing' | 'ready' | 'failed' | 'deleted';

const bigintAsNumber = {
  to: (v: number | null) => v,
  from: (v: string | number | null) => (v === null ? null : Number(v)),
};

/** AWS-hosted video (see migration 2205800000000). */
@Entity('video_assets')
@Index('IDX_video_assets_owner', ['owner_user_id'])
export class VideoAsset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'owner_user_id' })
  owner_user_id!: string;

  @Column({ type: 'varchar', length: 255, name: 'source_bucket' })
  source_bucket!: string;

  @Column({ type: 'varchar', length: 500, name: 'source_key' })
  source_key!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'output_bucket' })
  output_bucket!: string | null;

  /** Key prefix of the HLS ladder, e.g. `video/<id>/`. The viewer URL is `/<output_prefix>hls/index.m3u8`. */
  @Column({ type: 'varchar', length: 500, nullable: true, name: 'output_prefix' })
  output_prefix!: string | null;

  @Column({ type: 'varchar', length: 12, default: 'uploaded' })
  status!: VideoAssetStatus;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'mediaconvert_job_id' })
  mediaconvert_job_id!: string | null;

  @Column({ type: 'int', nullable: true, name: 'duration_seconds' })
  duration_seconds!: number | null;

  @Column({ type: 'int', nullable: true })
  width!: number | null;

  @Column({ type: 'int', nullable: true })
  height!: number | null;

  @Column({ type: 'bigint', nullable: true, name: 'size_bytes', transformer: bigintAsNumber })
  size_bytes!: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'thumbnail_key' })
  thumbnail_key!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'error_message' })
  error_message!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
