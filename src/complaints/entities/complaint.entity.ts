import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { ComplaintStatus } from '../enums/complaint-status.enum';
import { ComplaintType } from '../enums/complaint-type.enum';

@Entity('complaints')
@Index('IDX_complaints_student_id', ['student_id'])
@Index('IDX_complaints_status', ['status'])
@Index('IDX_complaints_type', ['type'])
@Index('IDX_complaints_created_at', ['created_at'])
export class Complaint {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false, name: 'student_id' })
  student_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'student_id' })
  student!: User;

  @Column({
    type: 'enum',
    enum: ComplaintType,
    nullable: false,
  })
  type!: ComplaintType;

  @Column({ type: 'uuid', nullable: true, name: 'target_id' })
  target_id!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: false })
  subject!: string;

  @Column({ type: 'text', nullable: false })
  description!: string;

  @Column({
    type: 'enum',
    enum: ComplaintStatus,
    default: ComplaintStatus.PENDING,
  })
  status!: ComplaintStatus;

  @Column({ type: 'text', nullable: true, name: 'admin_response' })
  admin_response!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'admin_id' })
  admin_id!: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'admin_id' })
  admin!: User | null;

  @Column({ type: 'timestamp', nullable: true, name: 'responded_at' })
  responded_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
