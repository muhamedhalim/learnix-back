import type { Relation } from 'typeorm';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { encryptedTextTransformer } from '../../common/utils/secret-box.util';
import { User } from '../../users/entities/user.entity';
import { MeetingProvider } from './meeting-provider.enum';
import { TeacherMeetingAccountStatus } from './teacher-meeting-account-status.enum';

/**
 * A teacher's own OAuth connection to a meeting provider. `(teacher_id,
 * provider)` is unique — one connected account per provider per teacher,
 * mirroring per-teacher OAuth (AD-4). `teacher_id` references `users.id`,
 * NOT `teacher_profiles.id` (see the profile-vs-user trap in AD-3).
 */
@Entity('teacher_meeting_accounts')
@Unique('UQ_teacher_meeting_accounts_teacher_provider', ['teacher_id', 'provider'])
@Index('IDX_teacher_meeting_accounts_teacher', ['teacher_id'])
export class TeacherMeetingAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'teacher_id' })
  teacher_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'teacher_id' })
  teacher!: Relation<User>;

  @Column({ type: 'enum', enum: MeetingProvider, enumName: 'teacher_meeting_accounts_provider_enum' })
  provider!: MeetingProvider;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'provider_account_id' })
  provider_account_id!: string | null;

  @Column({ type: 'varchar', length: 320, nullable: true, name: 'provider_account_email' })
  provider_account_email!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'display_name' })
  display_name!: string | null;

  /**
   * Encrypted at rest via `encryptedTextTransformer`. Possession of either
   * token is sufficient to act as this teacher at the provider — like
   * `PushDevice.token`, never expose it in any DTO and never log it in full
   * (use `maskSecret` from `mask.util.ts` if a call site ever needs to
   * reference one for debugging).
   */
  @Column({ type: 'text', nullable: true, name: 'access_token_encrypted', transformer: encryptedTextTransformer })
  access_token_encrypted!: string | null;

  /** Same sensitivity and rules as `access_token_encrypted` above. */
  @Column({ type: 'text', nullable: true, name: 'refresh_token_encrypted', transformer: encryptedTextTransformer })
  refresh_token_encrypted!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'token_expires_at' })
  token_expires_at!: Date | null;

  @Column({ type: 'text', array: true, nullable: true })
  scopes!: string[] | null;

  @Column({
    type: 'enum',
    enum: TeacherMeetingAccountStatus,
    enumName: 'teacher_meeting_account_status_enum',
    default: TeacherMeetingAccountStatus.CONNECTED,
  })
  status!: TeacherMeetingAccountStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_verified_at' })
  last_verified_at!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  last_error!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at!: Date;
}
