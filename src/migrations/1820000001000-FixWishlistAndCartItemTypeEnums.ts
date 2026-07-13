import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `wishlist_items.item_type` / `cart_items.item_type` from
 * `varchar(20) CHECK (item_type IN ('lesson','package'))` to native enums.
 *
 * `CreateWishlistTable1768700000000` / `CreateCartTables1768613000000`
 * enforced the value set with a CHECK constraint instead of a Postgres enum
 * type — functionally similar, but `WishlistItem`/`CartItem` declare
 * `type: 'enum'`, so TypeORM's query builder expects the native type.
 * Verified directly against the DB (not a naming false positive, unlike
 * several other columns this audit initially flagged).
 */
export class FixWishlistAndCartItemTypeEnums1820000001000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "wishlist_items" DROP CONSTRAINT IF EXISTS "wishlist_items_item_type_check"`,
    );
    await q.query(`CREATE TYPE "wishlist_items_item_type_enum" AS ENUM ('lesson','package')`);
    await q.query(
      `ALTER TABLE "wishlist_items" ALTER COLUMN "item_type" TYPE "wishlist_items_item_type_enum" USING "item_type"::"wishlist_items_item_type_enum"`,
    );

    await q.query(
      `ALTER TABLE "cart_items" DROP CONSTRAINT IF EXISTS "cart_items_item_type_check"`,
    );
    await q.query(`CREATE TYPE "cart_items_item_type_enum" AS ENUM ('lesson','package')`);
    await q.query(
      `ALTER TABLE "cart_items" ALTER COLUMN "item_type" TYPE "cart_items_item_type_enum" USING "item_type"::"cart_items_item_type_enum"`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "cart_items" ALTER COLUMN "item_type" TYPE character varying(20) USING "item_type"::text`,
    );
    await q.query(`DROP TYPE "cart_items_item_type_enum"`);
    await q.query(
      `ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_item_type_check" CHECK ("item_type" IN ('lesson','package'))`,
    );

    await q.query(
      `ALTER TABLE "wishlist_items" ALTER COLUMN "item_type" TYPE character varying(20) USING "item_type"::text`,
    );
    await q.query(`DROP TYPE "wishlist_items_item_type_enum"`);
    await q.query(
      `ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_item_type_check" CHECK ("item_type" IN ('lesson','package'))`,
    );
  }
}
