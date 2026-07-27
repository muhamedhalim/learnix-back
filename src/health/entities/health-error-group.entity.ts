import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('health_error_groups')
@Index('UQ_health_error_fingerprint_env', ['fingerprint', 'environment'], {
  unique: true,
})
@Index('IDX_health_errors_last_seen', ['last_seen'])
export class HealthErrorGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  fingerprint!: string;

  @Column({ type: 'varchar', length: 20 })
  severity!: string;

  @Column({ type: 'varchar', length: 80 })
  source!: string;

  @Column({ type: 'varchar', length: 40 })
  environment!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  route!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  error_code!: string | null;

  @Column({ type: 'varchar', length: 500 })
  message!: string;

  @Column({ type: 'integer', default: 1 })
  occurrence_count!: number;

  @Column({ type: 'integer', nullable: true })
  affected_users!: number | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  correlation_id!: string | null;

  @Column({ type: 'timestamptz' })
  first_seen!: Date;

  @Column({ type: 'timestamptz' })
  last_seen!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
