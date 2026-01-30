import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1734986400000 implements MigrationInterface {
  public name = 'InitialSchema1734986400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enable UUID extension first
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // This migration creates all tables by syncing from entities
    // Using synchronize in a controlled migration
    await queryRunner.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying NOT NULL,
        "password" character varying NOT NULL,
        "full_name" character varying NOT NULL,
        "phone" character varying,
        "role" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "rejection_reason" text,
        "refresh_token" character varying,
        "firebase_uid" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "UQ_users_phone" UNIQUE ("phone"),
        CONSTRAINT "UQ_users_firebase_uid" UNIQUE ("firebase_uid"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email");
      CREATE INDEX IF NOT EXISTS "IDX_users_role" ON "users" ("role");
      CREATE INDEX IF NOT EXISTS "IDX_users_status" ON "users" ("status");
      CREATE INDEX IF NOT EXISTS "IDX_users_deleted_at" ON "users" ("deleted_at");

      -- Subjects table
      CREATE TABLE IF NOT EXISTS "subjects" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying NOT NULL,
        "title_ar" character varying,
        "description" text,
        "description_ar" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_subjects" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_subjects_deleted_at" ON "subjects" ("deleted_at");

      -- Teacher profiles table
      CREATE TABLE IF NOT EXISTS "teacher_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "bio" text,
        "bio_ar" text,
        "qualifications" text,
        "qualifications_ar" text,
        "experience_years" integer,
        "hourly_rate" numeric(10,2),
        "profile_picture" character varying,
        "rating" numeric(3,2) DEFAULT 0,
        "total_ratings" integer DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "UQ_teacher_profiles_user_id" UNIQUE ("user_id"),
        CONSTRAINT "PK_teacher_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_teacher_profiles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_teacher_profiles_rating" ON "teacher_profiles" ("rating");
      CREATE INDEX IF NOT EXISTS "IDX_teacher_profiles_deleted_at" ON "teacher_profiles" ("deleted_at");

      -- Teacher subjects (many-to-many)
      CREATE TABLE IF NOT EXISTS "teacher_subjects" (
        "teacher_profile_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        CONSTRAINT "PK_teacher_subjects" PRIMARY KEY ("teacher_profile_id", "subject_id"),
        CONSTRAINT "FK_teacher_subjects_teacher" FOREIGN KEY ("teacher_profile_id") REFERENCES "teacher_profiles"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_teacher_subjects_subject" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_teacher_subjects_teacher" ON "teacher_subjects" ("teacher_profile_id");
      CREATE INDEX IF NOT EXISTS "IDX_teacher_subjects_subject" ON "teacher_subjects" ("subject_id");

      -- Student profiles table
      CREATE TABLE IF NOT EXISTS "student_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "grade_level" character varying,
        "school" character varying,
        "parent_name" character varying,
        "parent_phone" character varying,
        "parent_email" character varying,
        "address" jsonb,
        "profile_picture" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "UQ_student_profiles_user_id" UNIQUE ("user_id"),
        CONSTRAINT "PK_student_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_student_profiles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_student_profiles_deleted_at" ON "student_profiles" ("deleted_at");

      -- Lessons table
      CREATE TABLE IF NOT EXISTS "lessons" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying NOT NULL,
        "title_ar" character varying,
        "description" text,
        "description_ar" text,
        "teacher_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        "price" numeric(10,2) NOT NULL,
        "duration_minutes" integer NOT NULL,
        "vimeo_video_id" character varying,
        "vimeo_embed_html" text,
        "thumbnail_url" character varying,
        "difficulty_level" character varying,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_lessons" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lessons_teacher" FOREIGN KEY ("teacher_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_lessons_subject" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_lessons_teacher_id" ON "lessons" ("teacher_id");
      CREATE INDEX IF NOT EXISTS "IDX_lessons_subject_id" ON "lessons" ("subject_id");
      CREATE INDEX IF NOT EXISTS "IDX_lessons_deleted_at" ON "lessons" ("deleted_at");

      -- Lesson packages table
      CREATE TABLE IF NOT EXISTS "lesson_packages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying NOT NULL,
        "title_ar" character varying,
        "description" text,
        "description_ar" text,
        "teacher_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        "price" numeric(10,2) NOT NULL,
        "original_price" numeric(10,2) NOT NULL,
        "is_active" boolean DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_lesson_packages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lesson_packages_teacher" FOREIGN KEY ("teacher_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_lesson_packages_subject" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_teacher_id" ON "lesson_packages" ("teacher_id");
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_subject_id" ON "lesson_packages" ("subject_id");
      CREATE INDEX IF NOT EXISTS "IDX_lesson_packages_deleted_at" ON "lesson_packages" ("deleted_at");

      -- Lesson package items table
      CREATE TABLE IF NOT EXISTS "lesson_package_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "package_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "order_index" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lesson_package_items" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_lesson_package_items" UNIQUE ("package_id", "lesson_id"),
        CONSTRAINT "FK_lesson_package_items_package" FOREIGN KEY ("package_id") REFERENCES "lesson_packages"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_lesson_package_items_lesson" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_lesson_package_items_package_id" ON "lesson_package_items" ("package_id");
      CREATE INDEX IF NOT EXISTS "IDX_lesson_package_items_lesson_id" ON "lesson_package_items" ("lesson_id");

      -- Exams table
      CREATE TABLE IF NOT EXISTS "exams" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying NOT NULL,
        "title_ar" character varying,
        "description" text,
        "description_ar" text,
        "teacher_id" uuid NOT NULL,
        "lesson_id" uuid,
        "subject_id" uuid NOT NULL,
        "questions" jsonb NOT NULL,
        "duration_minutes" integer NOT NULL,
        "passing_score" numeric(5,2) NOT NULL,
        "total_points" numeric(10,2) NOT NULL,
        "is_active" boolean DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_exams" PRIMARY KEY ("id"),
        CONSTRAINT "FK_exams_teacher" FOREIGN KEY ("teacher_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_exams_lesson" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id"),
        CONSTRAINT "FK_exams_subject" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_exams_teacher_id" ON "exams" ("teacher_id");
      CREATE INDEX IF NOT EXISTS "IDX_exams_lesson_id" ON "exams" ("lesson_id");
      CREATE INDEX IF NOT EXISTS "IDX_exams_subject_id" ON "exams" ("subject_id");
      CREATE INDEX IF NOT EXISTS "IDX_exams_deleted_at" ON "exams" ("deleted_at");

      -- Exam attempts table
      CREATE TABLE IF NOT EXISTS "exam_attempts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "exam_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "answers" jsonb NOT NULL,
        "score" numeric(10,2),
        "status" character varying NOT NULL DEFAULT 'IN_PROGRESS',
        "started_at" TIMESTAMP NOT NULL DEFAULT now(),
        "submitted_at" TIMESTAMP,
        "graded_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_exam_attempts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_exam_attempts_exam_student" UNIQUE ("exam_id", "student_id"),
        CONSTRAINT "FK_exam_attempts_exam" FOREIGN KEY ("exam_id") REFERENCES "exams"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_exam_attempts_student" FOREIGN KEY ("student_id") REFERENCES "users"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_exam_attempts_exam_id" ON "exam_attempts" ("exam_id");
      CREATE INDEX IF NOT EXISTS "IDX_exam_attempts_student_id" ON "exam_attempts" ("student_id");
      CREATE INDEX IF NOT EXISTS "IDX_exam_attempts_status" ON "exam_attempts" ("status");

      -- Payments table
      CREATE TABLE IF NOT EXISTS "payments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "student_id" uuid NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "currency" character varying NOT NULL DEFAULT 'EGP',
        "status" character varying NOT NULL DEFAULT 'PENDING',
        "payment_method" character varying NOT NULL,
        "transaction_id" character varying,
        "paymob_order_id" character varying,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_payments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_payments_transaction_id" UNIQUE ("transaction_id"),
        CONSTRAINT "FK_payments_student" FOREIGN KEY ("student_id") REFERENCES "users"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_payments_student_id" ON "payments" ("student_id");
      CREATE INDEX IF NOT EXISTS "IDX_payments_status" ON "payments" ("status");
      CREATE INDEX IF NOT EXISTS "IDX_payments_transaction_id" ON "payments" ("transaction_id");

      -- Lesson purchases table
      CREATE TABLE IF NOT EXISTS "lesson_purchases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "payment_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "access_expires_at" TIMESTAMP NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lesson_purchases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_lesson_purchases_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id"),
        CONSTRAINT "FK_lesson_purchases_student" FOREIGN KEY ("student_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_lesson_purchases_lesson" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_lesson_purchases_student_id" ON "lesson_purchases" ("student_id");
      CREATE INDEX IF NOT EXISTS "IDX_lesson_purchases_lesson_id" ON "lesson_purchases" ("lesson_id");
      CREATE INDEX IF NOT EXISTS "IDX_lesson_purchases_access_expires_at" ON "lesson_purchases" ("access_expires_at");

      -- Package purchases table
      CREATE TABLE IF NOT EXISTS "package_purchases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "payment_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "package_id" uuid NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_package_purchases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_package_purchases_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id"),
        CONSTRAINT "FK_package_purchases_student" FOREIGN KEY ("student_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_package_purchases_package" FOREIGN KEY ("package_id") REFERENCES "lesson_packages"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_package_purchases_student_id" ON "package_purchases" ("student_id");
      CREATE INDEX IF NOT EXISTS "IDX_package_purchases_package_id" ON "package_purchases" ("package_id");

      -- Discount codes table
      CREATE TABLE IF NOT EXISTS "discount_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying NOT NULL,
        "discount_type" character varying NOT NULL,
        "discount_value" numeric(10,2) NOT NULL,
        "applicable_to" character varying NOT NULL,
        "min_purchase_amount" numeric(10,2),
        "max_uses" integer,
        "used_count" integer DEFAULT 0,
        "expires_at" TIMESTAMP,
        "is_active" boolean DEFAULT true,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_discount_codes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_discount_codes_code" UNIQUE ("code")
      );
      CREATE INDEX IF NOT EXISTS "IDX_discount_codes_code" ON "discount_codes" ("code");
      CREATE INDEX IF NOT EXISTS "IDX_discount_codes_is_active" ON "discount_codes" ("is_active");
      CREATE INDEX IF NOT EXISTS "IDX_discount_codes_deleted_at" ON "discount_codes" ("deleted_at");

      -- Discount code usage table
      CREATE TABLE IF NOT EXISTS "discount_code_usage" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "discount_code_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "payment_id" uuid NOT NULL,
        "discount_amount" numeric(10,2) NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_discount_code_usage" PRIMARY KEY ("id"),
        CONSTRAINT "FK_discount_code_usage_code" FOREIGN KEY ("discount_code_id") REFERENCES "discount_codes"("id"),
        CONSTRAINT "FK_discount_code_usage_student" FOREIGN KEY ("student_id") REFERENCES "users"("id"),
        CONSTRAINT "FK_discount_code_usage_payment" FOREIGN KEY ("payment_id") REFERENCES "payments"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_discount_code_usage_discount_code_id" ON "discount_code_usage" ("discount_code_id");
      CREATE INDEX IF NOT EXISTS "IDX_discount_code_usage_student_id" ON "discount_code_usage" ("student_id");

      -- Purchase codes table
      CREATE TABLE IF NOT EXISTS "purchase_codes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code" character varying NOT NULL,
        "code_type" character varying NOT NULL,
        "lesson_id" uuid,
        "package_id" uuid,
        "is_used" boolean DEFAULT false,
        "used_by_id" uuid,
        "used_at" TIMESTAMP,
        "expires_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_purchase_codes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_purchase_codes_code" UNIQUE ("code"),
        CONSTRAINT "FK_purchase_codes_lesson" FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id"),
        CONSTRAINT "FK_purchase_codes_package" FOREIGN KEY ("package_id") REFERENCES "lesson_packages"("id"),
        CONSTRAINT "FK_purchase_codes_used_by" FOREIGN KEY ("used_by_id") REFERENCES "users"("id")
      );
      CREATE INDEX IF NOT EXISTS "IDX_purchase_codes_code" ON "purchase_codes" ("code");
      CREATE INDEX IF NOT EXISTS "IDX_purchase_codes_is_used" ON "purchase_codes" ("is_used");
      CREATE INDEX IF NOT EXISTS "IDX_purchase_codes_deleted_at" ON "purchase_codes" ("deleted_at");

      -- Notifications table
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "type" character varying NOT NULL,
        "title" character varying NOT NULL,
        "title_ar" character varying,
        "message" text NOT NULL,
        "message_ar" text,
        "is_read" boolean DEFAULT false,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notifications_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS "IDX_notifications_user_id" ON "notifications" ("user_id");
      CREATE INDEX IF NOT EXISTS "IDX_notifications_is_read" ON "notifications" ("is_read");
      CREATE INDEX IF NOT EXISTS "IDX_notifications_created_at" ON "notifications" ("created_at");

      -- Notification settings table
      CREATE TABLE IF NOT EXISTS "notification_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "email_enabled" boolean DEFAULT true,
        "sms_enabled" boolean DEFAULT true,
        "push_enabled" boolean DEFAULT true,
        "notification_types" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_settings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_notification_settings_user_id" UNIQUE ("user_id"),
        CONSTRAINT "FK_notification_settings_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS "notification_settings" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "purchase_codes" CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "discount_code_usage" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "discount_codes" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "package_purchases" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lesson_purchases" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "payments" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "exam_attempts" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "exams" CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "lesson_package_items" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "lesson_packages" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "lessons" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "student_profiles" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "teacher_subjects" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "teacher_profiles" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "subjects" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
  }
}
