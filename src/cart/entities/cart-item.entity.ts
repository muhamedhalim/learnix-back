import { Cart } from './cart.entity';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Cart item types
 */
export enum CartItemType {
  LESSON = 'lesson',
  PACKAGE = 'package',
}

/**
 * CartItem entity - Individual items in a shopping cart
 */
@Entity('cart_items')
@Index('IDX_cart_items_cart_id', ['cart_id'])
@Index('IDX_cart_items_item', ['item_type', 'item_id'])
export class CartItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'cart_id' })
  cart_id!: string;

  @ManyToOne(() => Cart, (cart) => cart.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  cart!: Cart;

  @Column({
    type: 'enum',
    enum: CartItemType,
    name: 'item_type',
  })
  item_type!: CartItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
