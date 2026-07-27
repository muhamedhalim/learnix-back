import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type { HealthStatus } from '../health.types';

@Entity('health_metrics')
@Index('IDX_health_metrics_component_bucket', ['component_id', 'resolution', 'bucket_start'], {
  unique: true,
})
@Index('IDX_health_metrics_bucket_start', ['bucket_start'])
export class HealthMetric {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 80 })
  component_id!: string;

  @Column({ type: 'varchar', length: 40 })
  category!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: HealthStatus;

  @Column({ type: 'integer', nullable: true })
  latency_ms!: number | null;

  @Column({ type: 'varchar', length: 10, default: 'raw' })
  resolution!: 'raw' | 'hour' | 'day';

  @Column({ type: 'timestamptz' })
  bucket_start!: Date;

  @Column({ type: 'integer', default: 1 })
  sample_count!: number;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metrics!: Record<string, number>;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
