import type { Relation } from 'typeorm';
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
import type { Comment } from './comment.entity';

@Entity('comment_replies')
@Index('IDX_comment_replies_comment_id', ['comment_id'])
@Index('IDX_comment_replies_teacher_id', ['teacher_id'])
@Index('IDX_comment_replies_created_at', ['created_at'])
export class CommentReply {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'comment_id' })
  comment_id!: string;

  @ManyToOne('Comment', 'replies', {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'comment_id' })
  comment!: Relation<Comment>;

  @Column({ type: 'uuid', nullable: false, name: 'teacher_id' })
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: User;

  @Column({ type: 'text', nullable: false, name: 'reply_text' })
  reply_text!: string;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
