import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { User } from '../../users/entities/user.entity';

/**
 * Purchasable item types a wishlist entry can reference.
 *
 * Mirrors the cart's polymorphic pattern (see `CartItemType`) but is declared
 * independently so the wishlist bounded context does not depend on cart
 * internals. The string values are intentionally identical to `CartItemType`
 * so a wishlist entry maps 1:1 onto a cart item during "move to cart".
 */
export enum WishlistItemType {
  LESSON = 'lesson',
  PACKAGE = 'package',
}

/**
 * WishlistItem — a single (user, item) favourite.
 *
 * Unlike the cart there is no parent row: a wishlist carries no discount code
 * or checkout state, so a flat table keyed by user_id is the simplest correct
 * model (KISS). Uniqueness on (user_id, item_type, item_id) prevents duplicate
 * hearts; the (item_type, item_id) index powers the "most wishlisted" analytic.
 */
@Entity('wishlist_items')
@Unique('UQ_wishlist_user_item', ['user_id', 'item_type', 'item_id'])
@Index('IDX_wishlist_items_user_id', ['user_id'])
@Index('IDX_wishlist_items_item', ['item_type', 'item_id'])
export class WishlistItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  user_id!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: WishlistItemType, name: 'item_type' })
  item_type!: WishlistItemType;

  @Column({ type: 'uuid', name: 'item_id' })
  item_id!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at!: Date;
}
