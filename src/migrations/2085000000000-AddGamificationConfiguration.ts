import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-018 — configurable Gamification (Admin XP rulesets + Teacher lesson
 * bonus campaigns). Additive only: two new tables, one new `xp_events`
 * reason enum value. Nothing existing is altered or dropped.
 *
 * `gamification_rule_sets` rows are immutable history after creation (see
 * `GamificationRuleSet`'s doc comment) — bootstrap seeds version 1 with
 * values copied EXACTLY from `gamification.constants.ts` so default scoring
 * is unchanged from day one, and it is what `GamificationRulesService`
 * resolves as "current" until an admin ever creates a later version.
 */
export class AddGamificationConfiguration2085000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // `ALTER TYPE ... ADD VALUE` is safe inside a transaction on Postgres 12+
    // as long as the new value is not *used* in the same transaction, which
    // this migration does not do (same convention as
    // 1800000002000-AddTeacherMessageEventType.ts).
    await q.query(`ALTER TYPE "xp_events_reason_enum" ADD VALUE IF NOT EXISTS 'campaign_bonus'`);

    // ---- gamification_rule_sets --------------------------------------------
    await q.query(
      `CREATE TABLE "gamification_rule_sets" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "version_number" integer NOT NULL,
         "xp_base_by_difficulty" jsonb NOT NULL,
         "combo_bonuses" jsonb NOT NULL,
         "streak_daily_bonus" integer NOT NULL,
         "streak_milestones" jsonb NOT NULL,
         "enabled" boolean NOT NULL DEFAULT true,
         "effective_from" TIMESTAMP WITH TIME ZONE NOT NULL,
         "created_by" uuid,
         "notes" character varying(500),
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_gamification_rule_sets" PRIMARY KEY ("id"),
         CONSTRAINT "UQ_gamification_rule_sets_version" UNIQUE ("version_number"),
         CONSTRAINT "FK_gamification_rule_sets_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_gamification_rule_sets_current" ON "gamification_rule_sets" ("enabled","effective_from")`,
    );

    // ---- gamification_campaigns ---------------------------------------------
    await q.query(
      `CREATE TABLE "gamification_campaigns" (
         "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
         "teacher_id" uuid NOT NULL,
         "lesson_id" uuid NOT NULL,
         "title" character varying(160) NOT NULL,
         "bonus_xp" integer NOT NULL,
         "enabled" boolean NOT NULL DEFAULT true,
         "start_at" TIMESTAMP WITH TIME ZONE NOT NULL,
         "end_at" TIMESTAMP WITH TIME ZONE,
         "created_at" TIMESTAMP NOT NULL DEFAULT now(),
         "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
         CONSTRAINT "PK_gamification_campaigns" PRIMARY KEY ("id"),
         CONSTRAINT "FK_gamification_campaigns_teacher" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE CASCADE,
         CONSTRAINT "FK_gamification_campaigns_lesson" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE
       )`,
    );
    await q.query(
      `CREATE INDEX "IDX_gamification_campaigns_teacher_id" ON "gamification_campaigns" ("teacher_id")`,
    );
    await q.query(
      `CREATE INDEX "IDX_gamification_campaigns_lesson_active" ON "gamification_campaigns" ("lesson_id","enabled")`,
    );

    // ---- bootstrap version 1: exact mirror of gamification.constants.ts ----
    await q.query(
      `INSERT INTO "gamification_rule_sets"
         ("version_number","xp_base_by_difficulty","combo_bonuses","streak_daily_bonus","streak_milestones","enabled","effective_from","created_by","notes")
       VALUES (
         1,
         '{"easy":10,"medium":20,"hard":35,"expert":55}'::jsonb,
         '[{"at":5,"xp":15},{"at":10,"xp":40},{"at":20,"xp":100}]'::jsonb,
         25,
         '[{"days":7,"xp":100},{"days":30,"xp":500},{"days":100,"xp":2000}]'::jsonb,
         true,
         TIMESTAMP WITH TIME ZONE '2020-01-01T00:00:00Z',
         NULL,
         'Bootstrap: mirrors the pre-DEF-018 hardcoded gamification.constants.ts values exactly.'
       )
       ON CONFLICT ("version_number") DO NOTHING`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "gamification_campaigns"`);
    await q.query(`DROP TABLE IF EXISTS "gamification_rule_sets"`);
    // Note: Postgres cannot drop a single enum value, so 'campaign_bonus' on
    // xp_events_reason_enum is intentionally left in place (harmless, same
    // convention as 1800000002000-AddTeacherMessageEventType.ts).
  }
}
