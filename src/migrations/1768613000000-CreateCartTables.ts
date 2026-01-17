import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create cart and cart_items tables for shopping cart functionality
 */
export class CreateCartTables1768613000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create carts table
    await queryRunner.query(`
      CREATE TABLE carts (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        discount_code VARCHAR(50),
        discount_amount DECIMAL(10, 2) DEFAULT 0 NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create unique index on user_id (one cart per user)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_carts_user_id"
        ON carts(user_id);
    `);

    // Create cart_items table
    await queryRunner.query(`
      CREATE TABLE cart_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
        item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('lesson', 'package')),
        item_id UUID NOT NULL,
        price DECIMAL(10, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create index on cart_id for efficient item lookups
    await queryRunner.query(`
      CREATE INDEX "IDX_cart_items_cart_id"
        ON cart_items(cart_id);
    `);

    // Create composite index on (item_type, item_id) for item reference lookups
    await queryRunner.query(`
      CREATE INDEX "IDX_cart_items_item"
        ON cart_items(item_type, item_id);
    `);

    console.log('Created cart tables with indexes');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes first
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cart_items_item";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cart_items_cart_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_carts_user_id";`);

    // Drop tables (cascade will handle foreign keys)
    await queryRunner.query(`DROP TABLE IF EXISTS cart_items;`);
    await queryRunner.query(`DROP TABLE IF EXISTS carts;`);

    console.log('Dropped cart tables');
  }
}
