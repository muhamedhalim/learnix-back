import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBooksAndAttendance1736445600000 implements MigrationInterface {
  public name = 'CreateBooksAndAttendance1736445600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create books table (all IDs are UUID for consistency)
    await queryRunner.query(`
      CREATE TABLE "books" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "title" character varying(255) NOT NULL,
        "title_ar" character varying(255) NOT NULL,
        "description" text,
        "description_ar" text,
        "teacher_id" uuid NOT NULL,
        "subject_id" uuid NOT NULL,
        "cover_image" character varying(500),
        "book_file" character varying(500) NOT NULL,
        "price" numeric(10,2) NOT NULL,
        "purchase_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        CONSTRAINT "PK_books" PRIMARY KEY ("id")
      )
    `);

    // Create indexes for books
    await queryRunner.query(`
      CREATE INDEX "IDX_books_title" ON "books" ("title")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_books_title_ar" ON "books" ("title_ar")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_books_teacher_id" ON "books" ("teacher_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_books_subject_id" ON "books" ("subject_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_books_created_at" ON "books" ("created_at")
    `);

    // Add foreign keys for books
    await queryRunner.query(`
      ALTER TABLE "books"
      ADD CONSTRAINT "FK_books_teacher"
      FOREIGN KEY ("teacher_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "books"
      ADD CONSTRAINT "FK_books_subject"
      FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE CASCADE
    `);

    // Create book_purchases table (all IDs are UUID)
    await queryRunner.query(`
      CREATE TABLE "book_purchases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "student_id" uuid NOT NULL,
        "book_id" uuid NOT NULL,
        "payment_id" uuid NOT NULL,
        "price_paid" numeric(10,2) NOT NULL,
        "purchased_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_book_purchases" PRIMARY KEY ("id")
      )
    `);

    // Create indexes for book_purchases
    await queryRunner.query(`
      CREATE INDEX "IDX_book_purchases_student_id" ON "book_purchases" ("student_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_book_purchases_book_id" ON "book_purchases" ("book_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_book_purchases_payment_id" ON "book_purchases" ("payment_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_book_purchases_student_book"
      ON "book_purchases" ("student_id", "book_id")
    `);

    // Add foreign keys for book_purchases
    await queryRunner.query(`
      ALTER TABLE "book_purchases"
      ADD CONSTRAINT "FK_book_purchases_student"
      FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "book_purchases"
      ADD CONSTRAINT "FK_book_purchases_book"
      FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "book_purchases"
      ADD CONSTRAINT "FK_book_purchases_payment"
      FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE
    `);

    // Create attendance_records table (all IDs are UUID)
    await queryRunner.query(`
      CREATE TABLE "attendance_records" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "student_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'present',
        "marked_by" uuid,
        "is_auto_marked" boolean NOT NULL DEFAULT false,
        "notes" text,
        "marked_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_attendance_records" PRIMARY KEY ("id")
      )
    `);

    // Create indexes for attendance_records
    await queryRunner.query(`
      CREATE INDEX "IDX_attendance_student_id" ON "attendance_records" ("student_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_attendance_lesson_id" ON "attendance_records" ("lesson_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_attendance_status" ON "attendance_records" ("status")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_attendance_marked_at" ON "attendance_records" ("marked_at")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_attendance_student_lesson"
      ON "attendance_records" ("student_id", "lesson_id")
    `);

    // Add foreign keys for attendance_records
    await queryRunner.query(`
      ALTER TABLE "attendance_records"
      ADD CONSTRAINT "FK_attendance_student"
      FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "attendance_records"
      ADD CONSTRAINT "FK_attendance_lesson"
      FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "attendance_records"
      ADD CONSTRAINT "FK_attendance_marker"
      FOREIGN KEY ("marked_by") REFERENCES "users"("id") ON DELETE SET NULL
    `);

    // Create lesson_sessions table (all IDs are UUID)
    await queryRunner.query(`
      CREATE TABLE "lesson_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "student_id" uuid NOT NULL,
        "lesson_id" uuid NOT NULL,
        "entered_at" TIMESTAMP NOT NULL DEFAULT now(),
        "exited_at" TIMESTAMP,
        "duration_seconds" integer NOT NULL DEFAULT 0,
        "watch_percentage" numeric(5,2) NOT NULL DEFAULT 0,
        "is_completed" boolean NOT NULL DEFAULT false,
        "ip_address" character varying(45),
        "device_info" character varying(255),
        CONSTRAINT "PK_lesson_sessions" PRIMARY KEY ("id")
      )
    `);

    // Create indexes for lesson_sessions
    await queryRunner.query(`
      CREATE INDEX "IDX_lesson_sessions_student_id" ON "lesson_sessions" ("student_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_lesson_sessions_lesson_id" ON "lesson_sessions" ("lesson_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_lesson_sessions_completed" ON "lesson_sessions" ("is_completed")
    `);

    // Add foreign keys for lesson_sessions
    await queryRunner.query(`
      ALTER TABLE "lesson_sessions"
      ADD CONSTRAINT "FK_lesson_sessions_student"
      FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "lesson_sessions"
      ADD CONSTRAINT "FK_lesson_sessions_lesson"
      FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id") ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse order
    await queryRunner.query(`DROP TABLE IF EXISTS "lesson_sessions" CASCADE`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "attendance_records" CASCADE`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "book_purchases" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "books" CASCADE`);
  }
}
