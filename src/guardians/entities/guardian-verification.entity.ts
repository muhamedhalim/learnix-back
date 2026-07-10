import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Guardian } from './guardian.entity';

/**
 * A single outstanding OTP challenge proving ownership of a guardian's phone.
 *
 * The code itself is never stored — only a SHA-256 hash, compared in constant
 * time. A row is consumed exactly once (`consumed_at`), and `attempts` caps
 * brute force against a 6-digit space.
 */
@Entity('guardian_verifications')
@Index('IDX_guardian_verifications_guardian', ['guardian_id'])
@Index('IDX_guardian_verifications_expires_at', ['expires_at'])
export class GuardianVerification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'guardian_id' })
  guardian_id!: string;

  @ManyToOne(() => Guardian, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'guardian_id' })
  guardian!: Guardian;

  /** Hex SHA-256 of the 6-digit code. Never the code. */
  @Column({ type: 'varchar', length: 64, name: 'code_hash' })
  code_hash!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  /** Set the moment the code is redeemed; a consumed row can never be reused. */
  @Column({ type: 'timestamptz', nullable: true, name: 'consumed_at' })
  consumed_at!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** The authenticated user who requested the challenge (audit trail). */
  @Column({ type: 'uuid', nullable: true, name: 'requested_by' })
  requested_by!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
