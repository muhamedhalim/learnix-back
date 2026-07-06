import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateExamEngine1783357608989 implements MigrationInterface {
    name = 'CreateExamEngine1783357608989'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Big-bang replacement: drop the legacy JSONB/index-based exam tables.
        // The project is pre-production and keeps no legacy exam data.
        await queryRunner.query(`DROP TABLE IF EXISTS "exam_attempts" CASCADE`);
        await queryRunner.query(`DROP TABLE IF EXISTS "exams" CASCADE`);

        await queryRunner.query(`CREATE TYPE "public"."questions_type_enum" AS ENUM('single_choice', 'multiple_select', 'true_false', 'fill_blank', 'numeric', 'essay')`);
        await queryRunner.query(`CREATE TYPE "public"."questions_difficulty_enum" AS ENUM('easy', 'medium', 'hard')`);
        await queryRunner.query(`CREATE TYPE "public"."questions_bloom_level_enum" AS ENUM('remember', 'understand', 'apply', 'analyze', 'evaluate', 'create')`);
        await queryRunner.query(`CREATE TABLE "questions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "teacher_id" uuid NOT NULL, "subject_id" uuid NOT NULL, "lesson_id" uuid, "chapter" character varying(255), "topic" character varying(255), "type" "public"."questions_type_enum" NOT NULL, "difficulty" "public"."questions_difficulty_enum", "bloom_level" "public"."questions_bloom_level_enum", "content" jsonb NOT NULL, "answer_key" jsonb NOT NULL, "default_marks" integer NOT NULL DEFAULT '1', "tags" text array NOT NULL DEFAULT '{}', "current_version" integer NOT NULL DEFAULT '1', "is_active" boolean NOT NULL DEFAULT true, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "PK_08a6d4b0f49ff300bf3a0ca60ac" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_questions_teacher_id" ON "questions" ("teacher_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_questions_subject_id" ON "questions" ("subject_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_questions_lesson_id" ON "questions" ("lesson_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_questions_type" ON "questions" ("type") `);
        await queryRunner.query(`CREATE INDEX "IDX_questions_difficulty" ON "questions" ("difficulty") `);
        await queryRunner.query(`CREATE INDEX "IDX_questions_deleted_at" ON "questions" ("deleted_at") `);
        await queryRunner.query(`CREATE TYPE "public"."question_versions_type_enum" AS ENUM('single_choice', 'multiple_select', 'true_false', 'fill_blank', 'numeric', 'essay')`);
        await queryRunner.query(`CREATE TABLE "question_versions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "question_id" uuid NOT NULL, "version" integer NOT NULL, "type" "public"."question_versions_type_enum" NOT NULL, "content" jsonb NOT NULL, "answer_key" jsonb NOT NULL, "default_marks" integer NOT NULL, "created_by" uuid NOT NULL, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_question_versions_question_version" UNIQUE ("question_id", "version"), CONSTRAINT "PK_cf0e5fdf563f7d8286f7d8e68ea" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_question_versions_question_id" ON "question_versions" ("question_id") `);
        await queryRunner.query(`CREATE TYPE "public"."exams_status_enum" AS ENUM('draft', 'published', 'scheduled', 'archived')`);
        await queryRunner.query(`CREATE TABLE "exams" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "teacher_id" uuid NOT NULL, "subject_id" uuid NOT NULL, "lesson_id" uuid, "title" character varying(255) NOT NULL, "title_ar" character varying(255) NOT NULL, "description" text, "description_ar" text, "status" "public"."exams_status_enum" NOT NULL DEFAULT 'draft', "config" jsonb NOT NULL, "total_marks" integer NOT NULL DEFAULT '0', "passing_marks" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "PK_b43159ee3efa440952794b4f53e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_exams_teacher_id" ON "exams" ("teacher_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exams_subject_id" ON "exams" ("subject_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exams_lesson_id" ON "exams" ("lesson_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exams_title" ON "exams" ("title") `);
        await queryRunner.query(`CREATE INDEX "IDX_exams_status" ON "exams" ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_exams_created_at" ON "exams" ("created_at") `);
        await queryRunner.query(`CREATE INDEX "IDX_exams_deleted_at" ON "exams" ("deleted_at") `);
        await queryRunner.query(`CREATE TABLE "exam_sections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "exam_id" uuid NOT NULL, "order_index" integer NOT NULL DEFAULT '0', "title" character varying(255), "title_ar" character varying(255), "description" text, "shuffle_questions" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_f0c07e5c86efbe4dee8bc3f6f2a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_exam_sections_exam_id" ON "exam_sections" ("exam_id") `);
        await queryRunner.query(`CREATE TYPE "public"."exam_questions_type_snapshot_enum" AS ENUM('single_choice', 'multiple_select', 'true_false', 'fill_blank', 'numeric', 'essay')`);
        await queryRunner.query(`CREATE TABLE "exam_questions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "exam_id" uuid NOT NULL, "section_id" uuid NOT NULL, "question_id" uuid NOT NULL, "question_version" integer NOT NULL, "type_snapshot" "public"."exam_questions_type_snapshot_enum" NOT NULL, "content_snapshot" jsonb NOT NULL, "answer_key_snapshot" jsonb NOT NULL, "order_index" integer NOT NULL DEFAULT '0', "marks" integer NOT NULL, "weight" numeric(5,2) NOT NULL DEFAULT '1', "is_bonus" boolean NOT NULL DEFAULT false, "required" boolean NOT NULL DEFAULT true, CONSTRAINT "UQ_exam_questions_exam_question" UNIQUE ("exam_id", "question_id"), CONSTRAINT "PK_a214d47c7964cb6356f413dc73c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_exam_questions_exam_id" ON "exam_questions" ("exam_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exam_questions_section_id" ON "exam_questions" ("section_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exam_questions_question_id" ON "exam_questions" ("question_id") `);
        await queryRunner.query(`CREATE TYPE "public"."exam_attempts_state_enum" AS ENUM('in_progress', 'submitted', 'grading', 'graded', 'expired', 'void')`);
        await queryRunner.query(`CREATE TABLE "exam_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "exam_id" uuid NOT NULL, "student_id" uuid NOT NULL, "attempt_number" integer NOT NULL DEFAULT '1', "state" "public"."exam_attempts_state_enum" NOT NULL DEFAULT 'in_progress', "shuffle_seed" integer NOT NULL DEFAULT '0', "started_at" TIMESTAMP WITH TIME ZONE NOT NULL, "deadline_at" TIMESTAMP WITH TIME ZONE NOT NULL, "submitted_at" TIMESTAMP WITH TIME ZONE, "auto_submitted" boolean NOT NULL DEFAULT false, "graded_at" TIMESTAMP WITH TIME ZONE, "score_auto" numeric(9,2), "score_manual" numeric(9,2), "score_total" numeric(9,2), "max_score" numeric(9,2) NOT NULL DEFAULT '0', "passed" boolean, "session_token" uuid NOT NULL, "idempotency_key" character varying(255), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_exam_attempts_exam_student_number" UNIQUE ("exam_id", "student_id", "attempt_number"), CONSTRAINT "PK_4eb6c7775e0a9c178ef7f4826f9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_exam_attempts_open_per_student" ON "exam_attempts" ("exam_id", "student_id") WHERE state = 'in_progress'`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_exam_attempts_idempotency" ON "exam_attempts" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_exam_attempts_state" ON "exam_attempts" ("state") `);
        await queryRunner.query(`CREATE INDEX "IDX_exam_attempts_student_id" ON "exam_attempts" ("student_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exam_attempts_exam_id" ON "exam_attempts" ("exam_id") `);
        await queryRunner.query(`CREATE TABLE "exam_attempt_answers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "attempt_id" uuid NOT NULL, "exam_question_id" uuid NOT NULL, "question_id" uuid NOT NULL, "question_version" integer NOT NULL, "order_index" integer NOT NULL DEFAULT '0', "response" jsonb, "score" numeric(9,2), "max_score" numeric(9,2) NOT NULL DEFAULT '0', "auto_graded" boolean NOT NULL DEFAULT false, "manual_required" boolean NOT NULL DEFAULT false, "is_correct" boolean, "graded_by" uuid, "feedback" text, "ai_suggested_score" numeric(9,2), "ai_confidence" numeric(5,2), "answered_at" TIMESTAMP WITH TIME ZONE, "time_spent_ms" integer NOT NULL DEFAULT '0', "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_exam_attempt_answers_attempt_question" UNIQUE ("attempt_id", "exam_question_id"), CONSTRAINT "PK_8c82d1bbf0367f62e22f2d437fb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_exam_attempt_answers_attempt_id" ON "exam_attempt_answers" ("attempt_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exam_attempt_answers_exam_question_id" ON "exam_attempt_answers" ("exam_question_id") `);
        await queryRunner.query(`CREATE INDEX "IDX_exam_attempt_answers_question_id" ON "exam_attempt_answers" ("question_id") `);
        await queryRunner.query(`ALTER TABLE "questions" ADD CONSTRAINT "FK_3f8e2ecaac05a8438fac683f279" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "questions" ADD CONSTRAINT "FK_bab312bafb550a655ece4bca116" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "questions" ADD CONSTRAINT "FK_fee6c7e147700ebf9e5023e73e3" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "question_versions" ADD CONSTRAINT "FK_9c563964fa0634f79052ed9eeb9" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exams" ADD CONSTRAINT "FK_2d2614a04127ac307a39f0280f4" FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exams" ADD CONSTRAINT "FK_432eeeb62e8ff8de6c2a341cd10" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exams" ADD CONSTRAINT "FK_a23f5a00313e7acb9afc3ed056e" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_sections" ADD CONSTRAINT "FK_dc264c5c55dc1c015bfdac3b428" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_questions" ADD CONSTRAINT "FK_7fa69d03d8ac4eb3f0e3ecf626e" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_questions" ADD CONSTRAINT "FK_d1372885951280081e6359b5ee5" FOREIGN KEY ("section_id") REFERENCES "exam_sections"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_questions" ADD CONSTRAINT "FK_7c1bce580fc4692acc719e76db8" FOREIGN KEY ("question_id") REFERENCES "questions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_attempts" ADD CONSTRAINT "FK_cccf5df8532bd51cf017f4a30a6" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_attempts" ADD CONSTRAINT "FK_a1ee06ef9e816f19d128918cba4" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_attempt_answers" ADD CONSTRAINT "FK_26f545460e69301952e2462af05" FOREIGN KEY ("attempt_id") REFERENCES "exam_attempts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "exam_attempt_answers" ADD CONSTRAINT "FK_80707dd0facb5ba19821297b92f" FOREIGN KEY ("exam_question_id") REFERENCES "exam_questions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "exam_attempt_answers" DROP CONSTRAINT "FK_80707dd0facb5ba19821297b92f"`);
        await queryRunner.query(`ALTER TABLE "exam_attempt_answers" DROP CONSTRAINT "FK_26f545460e69301952e2462af05"`);
        await queryRunner.query(`ALTER TABLE "exam_attempts" DROP CONSTRAINT "FK_a1ee06ef9e816f19d128918cba4"`);
        await queryRunner.query(`ALTER TABLE "exam_attempts" DROP CONSTRAINT "FK_cccf5df8532bd51cf017f4a30a6"`);
        await queryRunner.query(`ALTER TABLE "exam_questions" DROP CONSTRAINT "FK_7c1bce580fc4692acc719e76db8"`);
        await queryRunner.query(`ALTER TABLE "exam_questions" DROP CONSTRAINT "FK_d1372885951280081e6359b5ee5"`);
        await queryRunner.query(`ALTER TABLE "exam_questions" DROP CONSTRAINT "FK_7fa69d03d8ac4eb3f0e3ecf626e"`);
        await queryRunner.query(`ALTER TABLE "exam_sections" DROP CONSTRAINT "FK_dc264c5c55dc1c015bfdac3b428"`);
        await queryRunner.query(`ALTER TABLE "exams" DROP CONSTRAINT "FK_a23f5a00313e7acb9afc3ed056e"`);
        await queryRunner.query(`ALTER TABLE "exams" DROP CONSTRAINT "FK_432eeeb62e8ff8de6c2a341cd10"`);
        await queryRunner.query(`ALTER TABLE "exams" DROP CONSTRAINT "FK_2d2614a04127ac307a39f0280f4"`);
        await queryRunner.query(`ALTER TABLE "question_versions" DROP CONSTRAINT "FK_9c563964fa0634f79052ed9eeb9"`);
        await queryRunner.query(`ALTER TABLE "questions" DROP CONSTRAINT "FK_fee6c7e147700ebf9e5023e73e3"`);
        await queryRunner.query(`ALTER TABLE "questions" DROP CONSTRAINT "FK_bab312bafb550a655ece4bca116"`);
        await queryRunner.query(`ALTER TABLE "questions" DROP CONSTRAINT "FK_3f8e2ecaac05a8438fac683f279"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_attempt_answers_question_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_attempt_answers_exam_question_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_attempt_answers_attempt_id"`);
        await queryRunner.query(`DROP TABLE "exam_attempt_answers"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_attempts_exam_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_attempts_student_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_attempts_state"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_exam_attempts_idempotency"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_exam_attempts_open_per_student"`);
        await queryRunner.query(`DROP TABLE "exam_attempts"`);
        await queryRunner.query(`DROP TYPE "public"."exam_attempts_state_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_questions_question_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_questions_section_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_questions_exam_id"`);
        await queryRunner.query(`DROP TABLE "exam_questions"`);
        await queryRunner.query(`DROP TYPE "public"."exam_questions_type_snapshot_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exam_sections_exam_id"`);
        await queryRunner.query(`DROP TABLE "exam_sections"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_deleted_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_created_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_status"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_title"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_lesson_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_subject_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_exams_teacher_id"`);
        await queryRunner.query(`DROP TABLE "exams"`);
        await queryRunner.query(`DROP TYPE "public"."exams_status_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_question_versions_question_id"`);
        await queryRunner.query(`DROP TABLE "question_versions"`);
        await queryRunner.query(`DROP TYPE "public"."question_versions_type_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_questions_deleted_at"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_questions_difficulty"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_questions_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_questions_lesson_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_questions_subject_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_questions_teacher_id"`);
        await queryRunner.query(`DROP TABLE "questions"`);
        await queryRunner.query(`DROP TYPE "public"."questions_bloom_level_enum"`);
        await queryRunner.query(`DROP TYPE "public"."questions_difficulty_enum"`);
        await queryRunner.query(`DROP TYPE "public"."questions_type_enum"`);
    }

}
