import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** One global policy: complaints currently have no category/priority policy source. */
@Entity('support_sla_policies')
export class SupportSlaPolicy {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'int' }) first_response_hours!: number;
  @Column({ type: 'int' }) resolution_hours!: number;
  @Column({ type: 'int' }) warning_window_hours!: number;
  @Column({ type: 'boolean', default: true }) is_active!: boolean;
  @CreateDateColumn() created_at!: Date;
  @UpdateDateColumn() updated_at!: Date;
}
