import { User } from '../../users/entities/user.entity';
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

@Entity('activity_logs')
@Index('IDX_activity_logs_user_id', ['user_id'])
@Index('IDX_activity_logs_action', ['action'])
@Index('IDX_activity_logs_resource_type', ['resource_type'])
@Index('IDX_activity_logs_created_at', ['created_at'])
@Index('IDX_activity_logs_user_action', ['user_id', 'action'])
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 100 })
  action!: string;

  @Column({ type: 'varchar', length: 50, name: 'resource_type' })
  resource_type!: string;

  @Column({ type: 'uuid', nullable: true, name: 'resource_id' })
  resource_id!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ip_address!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'user_agent' })
  user_agent!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
