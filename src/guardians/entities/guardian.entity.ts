import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { GuardianVerificationStatus } from './guardian-verification-status.enum';
import { PreferredLanguage } from './preferred-language.enum';

/**
 * A parent/guardian as a first-class person, identified by a canonical E.164
 * phone number.
 *
 * Modelling the guardian separately from the student is what makes siblings
 * work: two students linked to the same `guardians` row means one parent, one
 * verification, one opt-out, and one message when a shared event fires. The old
 * design stored a `parent_phone` string on each student and could not express
 * that at all.
 */
@Entity('guardians')
export class Guardian {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Canonical E.164 (`+201012345678`). UNIQUE — this is the identity of a
   * guardian. Normalisation happens before persistence (see `phone.util`); a
   * non-canonical value here would silently defeat the uniqueness guarantee.
   */
  @Column({ type: 'varchar', length: 20, unique: true, name: 'phone_e164' })
  @Index('IDX_guardians_phone_e164')
  phone_e164!: string;

  @Column({ type: 'varchar', length: 150, nullable: true, name: 'full_name' })
  full_name!: string | null;

  @Column({
    type: 'enum',
    enum: PreferredLanguage,
    default: PreferredLanguage.AR,
    name: 'preferred_language',
  })
  preferred_language!: PreferredLanguage;

  @Column({
    type: 'enum',
    enum: GuardianVerificationStatus,
    default: GuardianVerificationStatus.UNVERIFIED,
    name: 'verification_status',
  })
  @Index('IDX_guardians_verification_status')
  verification_status!: GuardianVerificationStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'verified_at' })
  verified_at!: Date | null;

  /**
   * Whether this number is reachable on WhatsApp. Unknown until a provider tells
   * us: seeded optimistically for Egyptian mobiles and demoted to `false` when
   * Meta reports an undeliverable recipient, which lets the channel registry
   * fall back to SMS without re-probing on every send.
   */
  @Column({ type: 'boolean', default: false, name: 'whatsapp_capable' })
  whatsapp_capable!: boolean;

  /**
   * Set when the guardian replies STOP (or an admin opts them out). Suppresses
   * every non-transactional message regardless of per-student preferences.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'opted_out_at' })
  opted_out_at!: Date | null;

  // No `OneToMany` back-reference to StudentGuardian on purpose: `guardian.entity`
  // and `student-guardian.entity` would then import each other, and CommonJS
  // resolves that cycle with an uninitialised binding ("Cannot access 'Guardian'
  // before initialization") at decorator-evaluation time. Nothing needs the
  // inverse side — guardian→students is always reached through the link table.

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at' })
  deleted_at!: Date | null;
}
