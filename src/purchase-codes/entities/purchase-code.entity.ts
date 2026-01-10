import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { PurchaseCodeType } from './purchase-code-type.enum';

@Entity('purchase_codes')
@Index('IDX_purchase_codes_code', ['code'], { unique: true })
@Index('IDX_purchase_codes_used', ['is_used'])
@Index('IDX_purchase_codes_expires', ['expires_at'])
@Index('IDX_purchase_codes_type_item', ['type', 'item_id'])
export class PurchaseCode {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16, unique: true })
  code!: string;

  @Column({ type: 'enum', enum: PurchaseCodeType })
  type!: PurchaseCodeType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @Column({ type: 'boolean', default: false, name: 'is_used' })
  is_used!: boolean;

  @Column({ type: 'uuid', nullable: true, name: 'used_by' })
  used_by!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'used_by' })
  user!: User | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'used_at' })
  used_at!: Date | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expires_at!: Date;

  @Column({ type: 'uuid', name: 'created_by' })
  created_by!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator!: User;

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;
}
