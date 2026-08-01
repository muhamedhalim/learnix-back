import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCallCenterSupportResources2061000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "support_sla_policies" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "first_response_hours" integer NOT NULL, "resolution_hours" integer NOT NULL, "warning_window_hours" integer NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_support_sla_policies" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE TABLE "support_canned_responses" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "title" varchar(160) NOT NULL, "body" text NOT NULL, "is_active" boolean NOT NULL DEFAULT true, "created_by" uuid, "updated_by" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "PK_support_canned_responses" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE TABLE "support_knowledge_articles" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "title" varchar(200) NOT NULL, "body" text NOT NULL, "is_published" boolean NOT NULL DEFAULT false, "published_at" TIMESTAMP, "created_by" uuid, "updated_by" uuid, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "PK_support_knowledge_articles" PRIMARY KEY ("id"))`);
    await queryRunner.query(`CREATE INDEX "IDX_support_canned_responses_active" ON "support_canned_responses" ("is_active")`);
    await queryRunner.query(`CREATE INDEX "IDX_support_knowledge_articles_published" ON "support_knowledge_articles" ("is_published")`);
  }
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "support_knowledge_articles"'); await queryRunner.query('DROP TABLE "support_canned_responses"'); await queryRunner.query('DROP TABLE "support_sla_policies"');
  }
}
