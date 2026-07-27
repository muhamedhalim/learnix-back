import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('health_alert_rules')
@Index('UQ_health_alert_rules_key', ['key'], { unique: true })
export class HealthAlertRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  key!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ type: 'varchar', length: 80, nullable: true })
  component_id!: string | null;

  @Column({ type: 'varchar', length: 80 })
  metric!: string;

  @Column({ type: 'varchar', length: 12 })
  operator!: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

  @Column({ type: 'double precision' })
  threshold!: number;

  @Column({ type: 'integer', default: 300 })
  duration_seconds!: number;

  @Column({ type: 'integer', default: 1800 })
  cooldown_seconds!: number;

  @Column({ type: 'varchar', length: 20, default: 'warning' })
  severity!: 'info' | 'warning' | 'critical';

  @Column({ type: 'jsonb', default: () => '\'["in_app"]\'::jsonb' })
  channels!: string[];

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  recipients!: string[];

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  last_triggered_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
