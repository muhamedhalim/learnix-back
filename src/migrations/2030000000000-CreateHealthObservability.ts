import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateHealthObservability2030000000000 implements MigrationInterface {
  public name = 'CreateHealthObservability2030000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "health_metrics" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "component_id" character varying(80) NOT NULL,
        "category" character varying(40) NOT NULL,
        "status" character varying(20) NOT NULL,
        "latency_ms" integer,
        "resolution" character varying(10) NOT NULL DEFAULT 'raw',
        "bucket_start" TIMESTAMPTZ NOT NULL,
        "sample_count" integer NOT NULL DEFAULT 1,
        "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_health_metrics" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_health_metrics_status"
          CHECK ("status" IN ('healthy','warning','degraded','down','misconfigured','unknown')),
        CONSTRAINT "CHK_health_metrics_resolution"
          CHECK ("resolution" IN ('raw','hour','day'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_health_metrics_component_bucket"
       ON "health_metrics" ("component_id", "resolution", "bucket_start")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_health_metrics_bucket_start"
       ON "health_metrics" ("bucket_start")`,
    );

    await queryRunner.query(`
      CREATE TABLE "health_incidents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "fingerprint" character varying(160) NOT NULL,
        "component_id" character varying(80) NOT NULL,
        "severity" character varying(20) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "impact" character varying(500) NOT NULL,
        "root_cause" character varying(500),
        "resolution_summary" character varying(500),
        "started_at" TIMESTAMPTZ NOT NULL,
        "ended_at" TIMESTAMPTZ,
        "last_observed_at" TIMESTAMPTZ NOT NULL,
        "occurrence_count" integer NOT NULL DEFAULT 1,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_health_incidents" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_health_incidents_status"
          CHECK ("status" IN ('open','resolved'))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_health_incidents_status_started"
       ON "health_incidents" ("status", "started_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_health_incidents_component"
       ON "health_incidents" ("component_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "health_alert_rules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "key" character varying(100) NOT NULL,
        "name" character varying(160) NOT NULL,
        "component_id" character varying(80),
        "metric" character varying(80) NOT NULL,
        "operator" character varying(12) NOT NULL,
        "threshold" double precision NOT NULL,
        "duration_seconds" integer NOT NULL DEFAULT 300,
        "cooldown_seconds" integer NOT NULL DEFAULT 1800,
        "severity" character varying(20) NOT NULL DEFAULT 'warning',
        "channels" jsonb NOT NULL DEFAULT '["in_app"]'::jsonb,
        "recipients" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "enabled" boolean NOT NULL DEFAULT true,
        "last_triggered_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_health_alert_rules" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_health_alert_operator"
          CHECK ("operator" IN ('gt','gte','lt','lte','eq'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_health_alert_rules_key"
       ON "health_alert_rules" ("key")`,
    );

    await queryRunner.query(`
      CREATE TABLE "health_error_groups" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "fingerprint" character varying(160) NOT NULL,
        "severity" character varying(20) NOT NULL,
        "source" character varying(80) NOT NULL,
        "environment" character varying(40) NOT NULL,
        "route" character varying(120),
        "error_code" character varying(80),
        "message" character varying(500) NOT NULL,
        "occurrence_count" integer NOT NULL DEFAULT 1,
        "affected_users" integer,
        "correlation_id" character varying(100),
        "first_seen" TIMESTAMPTZ NOT NULL,
        "last_seen" TIMESTAMPTZ NOT NULL,
        "resolved_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_health_error_groups" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_health_error_fingerprint_env"
       ON "health_error_groups" ("fingerprint", "environment")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_health_errors_last_seen"
       ON "health_error_groups" ("last_seen")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "health_error_groups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "health_alert_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "health_incidents"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "health_metrics"`);
  }
}
