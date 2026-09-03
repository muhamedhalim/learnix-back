import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `priority`, `category`, and `link` to `notifications`. Plain
 * `varchar` (not a native Postgres enum, unlike `type`/`status`) so a future
 * admin-notification category can be added without an `ALTER TYPE`
 * migration — the same tradeoff already made for the `origin` column at the
 * TypeORM level.
 *
 * All three are nullable and start unpopulated for every existing row:
 * populated only for admin-facing notifications going forward (see
 * `AdminNotificationEvent`), every other notification simply leaves them
 * `null`, unchanged from today's behaviour.
 */
export class AddNotificationPriorityCategoryLink2092000000000 implements MigrationInterface {
  name = 'AddNotificationPriorityCategoryLink2092000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "priority" varchar(16)`);
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "category" varchar(32)`);
    await q.query(`ALTER TABLE "notifications" ADD COLUMN "link" varchar(500)`);
    await q.query(
      `CREATE INDEX "IDX_notifications_user_priority" ON "notifications" ("user_id", "priority")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_notifications_user_priority"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "link"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "category"`);
    await q.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "priority"`);
  }
}
