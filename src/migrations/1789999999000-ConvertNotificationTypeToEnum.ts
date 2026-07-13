import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `notifications.type` from free text to a native Postgres enum.
 *
 * `InitialSchema1734986400000` created `notifications` with
 * `"type" character varying NOT NULL` — plain text, no enum type. The
 * `Notification` entity was since redesigned to declare `type` as
 * `@Column({ type: 'enum', enum: NotificationType })`, which requires a
 * `notifications_type_enum` Postgres type to exist. No migration ever
 * created that type or converted the column — the only place
 * `notifications_type_enum` is even mentioned in this codebase is
 * `AddGamification1790000000000`'s `ALTER TYPE ... ADD VALUE 'gamification'`,
 * which assumes the enum is already there so it can extend it. That
 * assumption was never true on a database built purely from migrations
 * (i.e. production, where `synchronize` is hard-blocked) — only on a
 * database where TypeORM's `synchronize` had silently built the enum to
 * match the entity ahead of any migration ever being written for it. Same
 * root cause, same shape, as the `payments.user_id` gap fixed in
 * `FixPaymentsUserIdColumn1768675000000`.
 *
 * This migration creates the enum with exactly the label set
 * `NotificationType` had *before* `AddGamification` extends it —
 * ('attendance','exam_result','lesson_expiring','purchase','custom') —
 * so that migration's own `ADD VALUE 'gamification'` (left untouched, as
 * historical migrations must not be modified) is genuinely the step that
 * introduces that value, exactly as it was written to do.
 *
 * `type` has no default, so unlike `payments.status` there's no
 * DB-level fallback that could have inserted an unexpected value: every
 * row's `type` was set explicitly by application code, always with one of
 * the enum's own string values. If some pre-existing row's value still
 * doesn't match a label, the cast below fails loudly instead of guessing.
 */
export class ConvertNotificationTypeToEnum1789999999000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE "notifications_type_enum" AS ENUM ('attendance','exam_result','lesson_expiring','purchase','custom')`,
    );
    await q.query(
      `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE "notifications_type_enum" USING "type"::"notifications_type_enum"`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "notifications" ALTER COLUMN "type" TYPE character varying USING "type"::text`,
    );
    await q.query(`DROP TYPE "notifications_type_enum"`);
  }
}
