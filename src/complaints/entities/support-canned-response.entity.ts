import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('support_canned_responses')
export class SupportCannedResponse {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', length: 160 }) title!: string;
  @Column({ type: 'text' }) body!: string;
  @Column({ type: 'boolean', default: true }) is_active!: boolean;
  @Column({ type: 'uuid', nullable: true }) created_by!: string | null;
  @Column({ type: 'uuid', nullable: true }) updated_by!: string | null;
  @CreateDateColumn() created_at!: Date;
  @UpdateDateColumn() updated_at!: Date;
  @DeleteDateColumn() deleted_at!: Date | null;
}
