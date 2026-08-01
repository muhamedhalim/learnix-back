import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { Complaint } from './complaint.entity';

/**
 * Private evidence linked to the canonical complaints aggregate. The storage
 * key is excluded from normal selects and is never serialized to a client.
 */
@Entity('complaint_attachments')
@Index('IDX_complaint_attachments_complaint_created_at', ['complaint_id', 'created_at'])
export class ComplaintAttachment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'complaint_id' })
  complaint_id!: string;

  @ManyToOne(() => Complaint, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'complaint_id' })
  complaint!: Complaint;

  @Column({ type: 'uuid', nullable: true, name: 'uploader_id' })
  uploader_id!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'uploader_id' })
  uploader!: User | null;

  @Column({ type: 'varchar', length: 500, name: 'storage_key', select: false })
  storage_key!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_filename' })
  original_filename!: string;

  @Column({ type: 'varchar', length: 128, name: 'mime_type' })
  mime_type!: string;

  @Column({ type: 'bigint' })
  size!: string;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
