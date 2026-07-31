import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import { minorUnitsTransformer } from '../money.util';

@Entity('teacher_settlement_entries')
@Index('IDX_teacher_settlement_entries_settlement', ['settlement_id'])
@Index('UQ_teacher_settlement_entry_allocation', ['settlement_id', 'ledger_entry_id'], {
  unique: true,
})
export class SettlementEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'settlement_id' })
  settlement_id!: string;

  @Column({ type: 'uuid', name: 'ledger_entry_id' })
  ledger_entry_id!: string;

  /** Amount of this earning allocated to this settlement. */
  @Column({
    type: 'bigint',
    name: 'amount_minor',
    transformer: minorUnitsTransformer,
  })
  amount_minor!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
