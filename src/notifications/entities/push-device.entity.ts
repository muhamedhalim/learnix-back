import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';
import { PushDeviceDisabledReason, PushPlatform, PushProviderName } from './push-platform.enum';

/**
 * One push registration: a single (provider, token) pair belonging to one user
 * on one client install.
 *
 * A user has MANY of these — phone, laptop, lab machine — and every active one
 * is a delivery target. Nothing in this model assumes one device per user.
 *
 * Two uniqueness rules make repeated registration safe, and they answer
 * different questions:
 *
 *  - `UQ_push_devices_provider_token` — a registration token identifies exactly
 *    one install *globally*. FCM will hand the same token to whoever is signed
 *    in on that browser profile, so if a second user registers it we must
 *    reassign ownership rather than create a second row; otherwise the previous
 *    user's notifications would keep flowing to a handset they no longer hold.
 *  - `UQ_push_devices_user_device` (partial, `device_id IS NOT NULL`) — FCM
 *    rotates tokens. A client that reports a stable `device_id` updates its
 *    existing row on rotation instead of leaving a trail of dead tokens.
 *
 * `token` is sensitive application data: possession of it is sufficient to
 * push to that handset. It is never logged in full (see `maskSecret`) and never
 * returned by the API.
 */
@Entity('push_devices')
@Index('IDX_push_devices_user', ['user_id'])
@Index('UQ_push_devices_provider_token', ['provider', 'token'], { unique: true })
export class PushDevice {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({
    type: 'enum',
    enum: PushProviderName,
    default: PushProviderName.FCM,
  })
  provider!: PushProviderName;

  /** Provider registration token. Sensitive — never log or return it in full. */
  @Column({ type: 'text' })
  token!: string;

  @Column({ type: 'enum', enum: PushPlatform, default: PushPlatform.WEB })
  platform!: PushPlatform;

  /**
   * Stable client-generated install identifier, when the client can produce
   * one. Lets a token refresh update this row rather than accumulate rows.
   */
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'device_id' })
  device_id!: string | null;

  /** Free-text client hint (user agent family / model). Never a fingerprint. */
  @Column({ type: 'varchar', length: 200, nullable: true, name: 'device_label' })
  device_label!: string | null;

  /**
   * Delivery eligibility. `false` means revoked or provider-invalidated; the
   * row is kept (not deleted) so re-registering the same install is an update
   * and so an operator can see why delivery stopped.
   */
  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'revoked_at' })
  revoked_at!: Date | null;

  @Column({
    type: 'enum',
    enum: PushDeviceDisabledReason,
    nullable: true,
    name: 'disabled_reason',
  })
  disabled_reason!: PushDeviceDisabledReason | null;

  /** Refreshed on every re-registration; the client's liveness signal. */
  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  last_seen_at!: Date;

  /** Last time the provider ACCEPTED a message for this token. */
  @Column({ type: 'timestamptz', nullable: true, name: 'last_success_at' })
  last_success_at!: Date | null;

  /** Consecutive transient failures; reset on the next acceptance. */
  @Column({ type: 'int', default: 0, name: 'failure_count' })
  failure_count!: number;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  last_error!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;
}
