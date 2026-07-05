import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Double-charge protection: enforce at most one in-flight (pending/processing)
 * payment per (user_id, item_type, item_id) via a PARTIAL UNIQUE INDEX.
 *
 * Without this, two concurrent purchase initiations (double-click, refresh
 * during payment, retry) both pass the application-level "already has access"
 * check and each opens its own Paymob order — the user could complete both and
 * be charged twice. The DB index makes the second concurrent insert fail
 * atomically; the service translates that into a friendly 409 Conflict.
 *
 * Backward compatible: additive index only. Any pre-existing duplicate open
 * payments are collapsed to the newest before the unique index is created, so
 * the migration cannot fail on legacy data.
 */
export class AddOpenPaymentUniqueGuard1768680000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // Collapse pre-existing duplicates: keep the most recent open payment per
    // (user, item), expire the older ones so the unique index can be created.
    await q.query(`
      UPDATE "payments" p
      SET "status" = 'expired'
      WHERE p."status" IN ('pending', 'processing')
        AND EXISTS (
          SELECT 1 FROM "payments" q
          WHERE q."user_id" = p."user_id"
            AND q."item_type" = p."item_type"
            AND q."item_id" = p."item_id"
            AND q."status" IN ('pending', 'processing')
            AND (q."created_at" > p."created_at"
                 OR (q."created_at" = p."created_at" AND q."id" > p."id"))
        )
    `);

    await q.query(`
      CREATE UNIQUE INDEX "UQ_payments_open_per_user_item"
      ON "payments" ("user_id", "item_type", "item_id")
      WHERE "status" IN ('pending', 'processing')
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_payments_open_per_user_item"`);
  }
}
