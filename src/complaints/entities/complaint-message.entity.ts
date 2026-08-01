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
import { ComplaintMessageKind } from '../enums/complaint-message-kind.enum';
import { Complaint } from './complaint.entity';

/**
 * Append-only ticket conversation. Internal notes are deliberately stored in
 * the same ordered history as public replies, while the API enforces who may
 * see them. This avoids a parallel notes subsystem and gives later timeline
 * pages one canonical source of truth.
 */
@Entity('complaint_messages')
@Index('IDX_complaint_messages_complaint_created_at', ['complaint_id', 'created_at'])
export class ComplaintMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'complaint_id' })
  complaint_id!: string;

  @ManyToOne(() => Complaint, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'complaint_id' })
  complaint!: Complaint;

  @Column({ type: 'uuid', nullable: true, name: 'author_id' })
  author_id!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'author_id' })
  author!: User | null;

  @Column({ type: 'enum', enum: ComplaintMessageKind })
  kind!: ComplaintMessageKind;

  @Column({ type: 'text' })
  body!: string;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
