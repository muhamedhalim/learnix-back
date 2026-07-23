import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity('teacher_settlement_entries')
@Unique('UQ_teacher_settlement_ledger_entry', ['ledger_entry_id'])
@Index('IDX_teacher_settlement_entries_settlement', ['settlement_id'])
export class SettlementEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'settlement_id' })
  settlement_id!: string;

  @Column({ type: 'uuid', name: 'ledger_entry_id' })
  ledger_entry_id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
