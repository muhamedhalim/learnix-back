import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes technical monitoring alerts (component health, thresholds, scheduled
 * job failures) that were written into administrators' personal notification
 * inbox, e.g. "[WARNING][production] Component becomes degraded".
 *
 * Why those rows exist: `OperationalAlertService` fanned EVERY alert out as an
 * `origin = 'operational'` notification to every admin, including the
 * rule-engine's health alerts. The producer no longer does that (technical
 * alerts are now health-console / email / webhook only), so this migration only
 * clears what was already persisted.
 *
 * Selection is deliberately narrow and structural (never the title text):
 *   - `origin = 'operational'` AND
 *       - `source_event` starts with `health-rule:` (legacy rows stored the raw
 *         alert key — this is `HealthAlertService`), OR
 *       - `source_event` starts with `scheduled_job.` (scheduled-job monitor), OR
 *       - `source_event = 'operational_alert'` AND `category = 'system'`
 *         (current rows; `system` is the category every non-business alert key
 *         receives, whereas business incidents are `financial` / `security`).
 * Payment, refund, finance, security, approval, purchase and payout
 * notifications are never matched.
 *
 * Reversible: matching rows are copied into
 * `notifications_technical_alert_archive` before being deleted, and `down`
 * restores them. Their `notification_deliveries` rows cascade with the
 * notification (they were in-app/push fan-out bookkeeping for the same alert)
 * and are not restored. Monitoring history (`health_incidents`,
 * `health_metrics`, `health_alert_rules`, audit logs) is not touched.
 *
 * Idempotent: a second run matches nothing.
 */
export class RemoveTechnicalAdminNotifications2208000000000 implements MigrationInterface {
  public name = 'RemoveTechnicalAdminNotifications2208000000000';

  private static readonly ARCHIVE = 'notifications_technical_alert_archive';

  private static readonly COLUMNS = [
    'id',
    'dedupe_key',
    'user_id',
    'campaign_id',
    'created_by_user_id',
    'origin',
    'source_event',
    'type',
    'title',
    'message',
    'data',
    'priority',
    'category',
    'link',
    'is_read',
    'sent_at',
    'read_at',
    'sms_sent',
    'sms_to',
    'status',
    'attempts',
    'error_message',
    'delivered_at',
    'created_at',
  ]
    .map((column) => `"${column}"`)
    .join(', ');

  /** The one definition of "technical alert", shared by archive and delete. */
  public static readonly TECHNICAL_PREDICATE = `
    "origin" = 'operational'
    AND (
      "source_event" LIKE 'health-rule:%'
      OR "source_event" LIKE 'scheduled_job.%'
      OR ("source_event" = 'operational_alert' AND "category" = 'system')
    )`;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const archive = RemoveTechnicalAdminNotifications2208000000000.ARCHIVE;
    const columns = RemoveTechnicalAdminNotifications2208000000000.COLUMNS;
    const predicate = RemoveTechnicalAdminNotifications2208000000000.TECHNICAL_PREDICATE;

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "${archive}" (LIKE "notifications" INCLUDING DEFAULTS)`,
    );
    await queryRunner.query(
      `ALTER TABLE "${archive}" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `INSERT INTO "${archive}" (${columns})
         SELECT ${columns} FROM "notifications" n
          WHERE ${predicate}
            AND NOT EXISTS (SELECT 1 FROM "${archive}" a WHERE a."id" = n."id")`,
    );
    await queryRunner.query(`DELETE FROM "notifications" WHERE ${predicate}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const archive = RemoveTechnicalAdminNotifications2208000000000.ARCHIVE;
    const columns = RemoveTechnicalAdminNotifications2208000000000.COLUMNS;

    // Skip rows whose recipient no longer exists (FK) or that already came back.
    await queryRunner.query(
      `INSERT INTO "notifications" (${columns})
         SELECT ${columns} FROM "${archive}" a
          WHERE EXISTS (SELECT 1 FROM "users" u WHERE u."id" = a."user_id")
            AND NOT EXISTS (SELECT 1 FROM "notifications" n WHERE n."id" = a."id")`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "${archive}"`);
  }
}
