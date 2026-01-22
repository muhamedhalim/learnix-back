import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { User } from '../../users/entities/user.entity';
import { CommentReply } from './comment-reply.entity';

@Entity('comments')
@Index('IDX_comments_lesson_id', ['lesson_id'])
@Index('IDX_comments_student_id', ['student_id'])
@Index('IDX_comments_created_at', ['created_at'])
@Index('IDX_comments_lesson_created', ['lesson_id', 'created_at'])
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'lesson_id' })
  lesson_id!: string;

  @ManyToOne(() => Lesson, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'lesson_id' })
  lesson!: Lesson;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({ type: 'text', nullable: false, name: 'comment_text' })
  comment_text!: string;

  @OneToMany(() => CommentReply, (reply) => reply.comment, {
    cascade: ['soft-remove'],
    eager: false,
  })
  replies!: CommentReply[];

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
