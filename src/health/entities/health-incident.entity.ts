import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('health_incidents')
@Index('IDX_health_incidents_status_started', ['status', 'started_at'])
@Index('IDX_health_incidents_component', ['component_id'])
export class HealthIncident {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 80 })
  component_id!: string;

  @Column({ type: 'varchar', length: 20 })
  severity!: 'warning' | 'degraded' | 'critical';

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: 'open' | 'resolved';

  @Column({ type: 'varchar', length: 500 })
  impact!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  root_cause!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  resolution_summary!: string | null;

  @Column({ type: 'timestamptz' })
  started_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  ended_at!: Date | null;

  @Column({ type: 'timestamptz' })
  last_observed_at!: Date;

  @Column({ type: 'integer', default: 1 })
  occurrence_count!: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
