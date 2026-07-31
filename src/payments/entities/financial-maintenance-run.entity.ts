import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Immutable operational evidence for each isolated finance maintenance task. */
@Entity('financial_maintenance_runs')
@Index('IDX_financial_maintenance_runs_task_started', ['task_name', 'started_at'])
export class FinancialMaintenanceRun {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 80, name: 'task_name' })
  task_name!: string;

  @Column({ type: 'varchar', length: 120, name: 'worker_id' })
  worker_id!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: 'running' | 'succeeded' | 'failed' | 'skipped';

  @Column({ type: 'timestamptz', name: 'started_at' })
  started_at!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'finished_at' })
  finished_at!: Date | null;

  @Column({ type: 'bigint', default: 0, name: 'duration_ms' })
  duration_ms!: number;

  @Column({ type: 'integer', default: 0, name: 'processed_count' })
  processed_count!: number;

  @Column({ type: 'integer', default: 0, name: 'released_count' })
  released_count!: number;

  @Column({ type: 'integer', default: 0, name: 'error_count' })
  error_count!: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  error_message!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
