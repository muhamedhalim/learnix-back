import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `parent_messages` — the delivery ledger for the guardian notification pipeline.
 *
 * One row per (event, subject, guardian). The UNIQUE constraint on
 * `idempotency_key` is not an optimisation: it is the mechanism that makes the
 * pipeline exactly-once. The worker inserts the row before calling any
 * provider, so a retried job, a duplicated domain event, or two workers racing
 * all collide on this index and exactly one send happens.
 *
 * Status is deliberately richer than the old `notifications.status`: `sent`
 * means a provider accepted the message, `delivered` means a provider webhook
 * confirmed it reached a handset. The previous code conflated the two.
 */
export class CreateParentMessages1800000001000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TYPE "parent_messages_event_type_enum" AS ENUM (
        'exam_graded','attendance_marked','homework_assigned','lesson_completed',
        'course_purchased','weekly_report','monthly_report','guardian_verification'
      )`);
    await q.query(`CREATE TYPE "parent_messages_channel_enum" AS ENUM ('whatsapp','sms')`);
    await q.query(`
      CREATE TYPE "parent_messages_status_enum" AS ENUM
        ('queued','sent','delivered','read','failed','dead')`);

    await q.query(`
      CREATE TABLE "parent_messages" (
        "id"                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "idempotency_key"      character varying(200) NOT NULL,
        "guardian_id"          uuid NOT NULL,
        "student_id"           uuid NOT NULL,
        "event_type"           "parent_messages_event_type_enum" NOT NULL,
        "channel"              "parent_messages_channel_enum" NOT NULL,
        "status"               "parent_messages_status_enum" NOT NULL DEFAULT 'queued',
        "template_key"         character varying(100) NOT NULL,
        "body"                 text NOT NULL,
        "variables"            jsonb,
        "provider_message_id"  character varying(200),
        "attempts"             integer NOT NULL DEFAULT 0,
        "error_message"        text,
        "sent_at"              TIMESTAMP WITH TIME ZONE,
        "delivered_at"         TIMESTAMP WITH TIME ZONE,
        "read_at"              TIMESTAMP WITH TIME ZONE,
        "failed_at"            TIMESTAMP WITH TIME ZONE,
        "created_at"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_parent_messages_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "FK_parent_messages_guardian" FOREIGN KEY ("guardian_id")
          REFERENCES "guardians"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_parent_messages_student" FOREIGN KEY ("student_id")
          REFERENCES "users"("id") ON DELETE CASCADE
      )`);

    await q.query(`CREATE INDEX "IDX_parent_messages_guardian" ON "parent_messages" ("guardian_id")`);
    await q.query(`CREATE INDEX "IDX_parent_messages_student" ON "parent_messages" ("student_id")`);
    await q.query(`CREATE INDEX "IDX_parent_messages_status" ON "parent_messages" ("status")`);
    await q.query(`CREATE INDEX "IDX_parent_messages_event_type" ON "parent_messages" ("event_type")`);
    await q.query(`CREATE INDEX "IDX_parent_messages_created_at" ON "parent_messages" ("created_at")`);
    // Delivery webhooks arrive keyed only by the provider's message id.
    await q.query(
      `CREATE INDEX "IDX_parent_messages_provider_message_id" ON "parent_messages" ("provider_message_id")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "parent_messages"`);
    await q.query(`DROP TYPE IF EXISTS "parent_messages_status_enum"`);
    await q.query(`DROP TYPE IF EXISTS "parent_messages_channel_enum"`);
    await q.query(`DROP TYPE IF EXISTS "parent_messages_event_type_enum"`);
  }
}
