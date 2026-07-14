import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { User } from './user.entity';

@Entity('user_sessions')
@Index('IDX_user_sessions_user_id', ['user_id'])
@Index('IDX_user_sessions_refresh_token_id', ['refresh_token_id'], { unique: true })
@Index('IDX_user_sessions_last_active', ['last_active'])
export class UserSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'varchar', length: 64, name: 'refresh_token_id' })
  refresh_token_id!: string;

  @Column({ type: 'text', name: 'refresh_token_hash', select: false })
  refresh_token_hash!: string;

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'device_info' })
  device_info!: string | null;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ip_address!: string | null;

  @Column({ type: 'timestamp', name: 'last_active' })
  last_active!: Date;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @Column({ type: 'timestamp', name: 'expires_at' })
  expires_at!: Date;
}
