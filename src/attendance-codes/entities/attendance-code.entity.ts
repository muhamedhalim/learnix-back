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
import { AttendanceCodeType } from './attendance-code-type.enum';

@Entity('attendance_codes')
@Index('IDX_attendance_codes_code', ['code'], { unique: true })
@Index('IDX_attendance_codes_used', ['is_used'])
@Index('IDX_attendance_codes_expires', ['expires_at'])
@Index('IDX_attendance_codes_type_item', ['type', 'item_id'])
export class AttendanceCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16, unique: true })
  code!: string;

  @Column({ type: 'enum', enum: AttendanceCodeType })
  type!: AttendanceCodeType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @Column({ type: 'boolean', default: false, name: 'is_used' })
  is_used!: boolean;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  is_active!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'used_by' })
  used_by!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'used_by' })
  user!: User | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'used_at' })
  used_at!: Date | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator!: User;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
