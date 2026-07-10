import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the wishlist_items table.
 *
 * Flat, user-keyed favourites for lessons and packages. A partial parent row
 * (like the cart) is unnecessary — a wishlist has no discount/checkout state.
 * Uniqueness on (user_id, item_type, item_id) prevents duplicate hearts; the
 * (item_type, item_id) index powers the "most wishlisted" analytic.
 */
export class CreateWishlistTable1768700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE wishlist_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('lesson', 'package')),
        item_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_wishlist_user_item" UNIQUE (user_id, item_type, item_id)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wishlist_items_user_id"
        ON wishlist_items(user_id);
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_wishlist_items_item"
        ON wishlist_items(item_type, item_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wishlist_items_item";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wishlist_items_user_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS wishlist_items;`);
  }
}
