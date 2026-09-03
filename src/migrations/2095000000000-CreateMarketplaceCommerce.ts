import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Third marketplace migration (plan.md §3 migration 3 of 8). Orders,
 * enrollments and per-lesson progress (data-model.md §3) — the correctness
 * spine of the purchase flow. `CHK_mp_orders_split` is the database-level
 * guarantee that commission + instructor earning always reconciles to the
 * net amount (FR-130, FR-327).
 */
export class CreateMarketplaceCommerce2095000000000 implements MigrationInterface {
  public name = 'CreateMarketplaceCommerce2095000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_orders" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "order_number" character varying(40) NOT NULL,
        "learner_id" uuid NOT NULL,
        "course_id" uuid NOT NULL,
        "course_version_id" uuid NOT NULL,
        "instructor_id" uuid NOT NULL,
        "gross_amount_minor" bigint NOT NULL,
        "discount_amount_minor" bigint NOT NULL DEFAULT 0,
        "net_amount_minor" bigint NOT NULL,
        "currency" character(3) NOT NULL,
        "commission_bps" integer NOT NULL,
        "commission_scope" character varying(20) NOT NULL DEFAULT 'platform',
        "commission_amount_minor" bigint NOT NULL,
        "instructor_earning_minor" bigint NOT NULL,
        "refund_window_days" integer NOT NULL,
        "consumption_cap_bps" integer NOT NULL,
        "status" character varying(30) NOT NULL DEFAULT 'awaiting_payment',
        "is_zero_value" boolean NOT NULL DEFAULT false,
        "payment_id" uuid,
        "course_title_snapshot" character varying(255) NOT NULL,
        "instructor_name_snapshot" character varying(255) NOT NULL,
        "paid_at" timestamptz,
        "expires_at" timestamptz,
        "cancelled_at" timestamptz,
        "refunded_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_orders" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_orders_order_number" UNIQUE ("order_number"),
        CONSTRAINT "FK_mp_orders_learner" FOREIGN KEY ("learner_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_orders_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_orders_course_version" FOREIGN KEY ("course_version_id")
          REFERENCES "marketplace_course_versions" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_orders_instructor" FOREIGN KEY ("instructor_id")
          REFERENCES "marketplace_instructors" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_orders_amounts"
          CHECK ("net_amount_minor" = "gross_amount_minor" - "discount_amount_minor"),
        CONSTRAINT "CHK_mp_orders_split"
          CHECK ("commission_amount_minor" + "instructor_earning_minor" = "net_amount_minor"),
        CONSTRAINT "CHK_mp_orders_zero_value"
          CHECK ("is_zero_value" = ("net_amount_minor" = 0)),
        CONSTRAINT "CHK_mp_orders_nonneg" CHECK (
          "gross_amount_minor" >= 0 AND "discount_amount_minor" >= 0
          AND "net_amount_minor" >= 0 AND "commission_amount_minor" >= 0
          AND "instructor_earning_minor" >= 0
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_orders_open_per_course"
        ON "marketplace_orders" ("learner_id", "course_id")
        WHERE "status" IN ('awaiting_payment','paid');
      CREATE INDEX IF NOT EXISTS "IDX_mp_orders_learner_status"
        ON "marketplace_orders" ("learner_id", "status");
      CREATE INDEX IF NOT EXISTS "IDX_mp_orders_instructor_paid"
        ON "marketplace_orders" ("instructor_id", "paid_at");
      CREATE INDEX IF NOT EXISTS "IDX_mp_orders_revenue"
        ON "marketplace_orders" ("currency", "paid_at")
        WHERE "is_zero_value" = false;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_enrollments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "learner_id" uuid NOT NULL,
        "course_id" uuid NOT NULL,
        "course_version_id" uuid NOT NULL,
        "order_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "granted_at" timestamptz NOT NULL DEFAULT now(),
        "revoked_at" timestamptz,
        "revocation_reason" text,
        "progress_bps" integer NOT NULL DEFAULT 0,
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_enrollments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_enrollments_order" UNIQUE ("order_id"),
        CONSTRAINT "FK_mp_enrollments_learner" FOREIGN KEY ("learner_id")
          REFERENCES "users" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_enrollments_course" FOREIGN KEY ("course_id")
          REFERENCES "marketplace_courses" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_enrollments_course_version" FOREIGN KEY ("course_version_id")
          REFERENCES "marketplace_course_versions" ("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_mp_enrollments_order" FOREIGN KEY ("order_id")
          REFERENCES "marketplace_orders" ("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_mp_enrollments_progress_range"
          CHECK ("progress_bps" >= 0 AND "progress_bps" <= 10000)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_enrollments_active_learner_course"
        ON "marketplace_enrollments" ("learner_id", "course_id")
        WHERE "status" = 'active';
      CREATE INDEX IF NOT EXISTS "IDX_mp_enrollments_course"
        ON "marketplace_enrollments" ("course_id");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "marketplace_lesson_progress" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "enrollment_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "is_completed" boolean NOT NULL DEFAULT false,
        "last_position_seconds" integer NOT NULL DEFAULT 0,
        "completed_at" timestamptz,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_mp_lesson_progress" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_mp_progress_enrollment_lesson" UNIQUE ("enrollment_id", "lesson_id"),
        CONSTRAINT "FK_mp_progress_enrollment" FOREIGN KEY ("enrollment_id")
          REFERENCES "marketplace_enrollments" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_mp_progress_lesson" FOREIGN KEY ("lesson_id")
          REFERENCES "marketplace_course_lessons" ("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_lesson_progress"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_enrollments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "marketplace_orders"`);
  }
}
