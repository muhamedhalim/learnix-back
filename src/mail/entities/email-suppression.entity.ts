import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type EmailSuppressionReason = 'bounce' | 'complaint';

/**
 * Addresses we must stop emailing: permanent SES bounces and spam complaints. Keeping our own list (on
 * top of SES's account-level one) protects sender reputation in every environment and lets the mail
 * funnel refuse a send before it reaches the provider.
 */
@Entity('email_suppressions')
@Unique('UQ_email_suppressions_email', ['email'])
export class EmailSuppression {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_email_suppressions_id' })
  id!: string;

  /** Lower-cased address. */
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 16 })
  reason!: EmailSuppressionReason;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
