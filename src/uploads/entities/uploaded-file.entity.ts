import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

export type UploadFolderType = 'resources' | 'thumbnails' | 'profiles';

@Entity('uploaded_files')
@Index('IDX_uploaded_files_filename', ['filename'], { unique: true })
@Index('IDX_uploaded_files_uploader_id', ['uploader_id'])
@Index('IDX_uploaded_files_created_at', ['created_at'])
export class UploadedFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  filename!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_filename' })
  original_filename!: string;

  @Column({ type: 'varchar', length: 50 })
  folder!: UploadFolderType;

  @Column({ type: 'varchar', length: 100, name: 'mime_type' })
  mime_type!: string;

  @Column({ type: 'bigint' })
  size!: number;

  @Column({ type: 'uuid', nullable: true, name: 'uploader_id' })
  uploader_id!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'uploader_id' })
  uploader!: Relation<User> | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
