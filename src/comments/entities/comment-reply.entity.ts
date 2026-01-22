import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { Comment } from './comment.entity';
import { User } from '../../users/entities/user.entity';

@Entity('comment_replies')
@Index('IDX_comment_replies_comment_id', ['comment_id'])
@Index('IDX_comment_replies_teacher_id', ['teacher_id'])
@Index('IDX_comment_replies_created_at', ['created_at'])
export class CommentReply {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'comment_id' })
  comment_id!: string;

  @ManyToOne(() => Comment, (comment) => comment.replies, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'comment_id' })
  comment!: Comment;

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
