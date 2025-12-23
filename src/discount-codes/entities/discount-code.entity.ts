import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { DiscountType } from './discount-type.enum';
import { DiscountCodeUsage } from './discount-code-usage.entity';

@Entity('discount_codes')
@Index('IDX_discount_codes_code', ['code'], { unique: true })
@Index('IDX_discount_codes_active', ['is_active'])
@Index('IDX_discount_codes_valid_dates', ['valid_from', 'valid_until'])
export class DiscountCode {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 50, unique: true })
  code!: string;

  @Column({ type: 'enum', enum: DiscountType, name: 'discount_type' })
  discount_type!: DiscountType;

  @Column({ type: 'decimal', precision: 10, scale: 2, name: 'discount_value' })
  discount_value!: number;

  @Column({ type: 'simple-array', name: 'applicable_to' })
  applicable_to!: string[];

  @Column({ type: 'jsonb', nullable: true, name: 'item_ids' })
  item_ids!: number[] | null;

  @Column({ type: 'int', default: 1, name: 'max_uses' })
  max_uses!: number;

  @Column({ type: 'int', default: 0, name: 'used_count' })
  used_count!: number;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    name: 'min_purchase_amount',
  })
  min_purchase_amount!: number;

  @Column({ type: 'timestamptz', name: 'valid_from' })
  valid_from!: Date;

  @Column({ type: 'timestamptz', name: 'valid_until' })
  valid_until!: Date;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  is_active!: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @OneToMany(() => DiscountCodeUsage, (usage) => usage.discount_code)
  usages!: DiscountCodeUsage[];

  @CreateDateColumn({ name: 'created_at' })
  created_at!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at!: Date;

  @DeleteDateColumn({ name: 'deleted_at', nullable: true })
  deleted_at!: Date | null;
}
