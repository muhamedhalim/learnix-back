import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `teacher_message` to `parent_messages_event_type_enum` for the
 * teacher-initiated broadcast feature (class / absentees / low grades).
 *
 * `ALTER TYPE ... ADD VALUE` is safe inside a transaction on Postgres 12+ as
 * long as the new value is not *used* in the same transaction, which this
 * migration does not do.
 */
export class AddTeacherMessageEventType1800000002000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TYPE "parent_messages_event_type_enum" ADD VALUE IF NOT EXISTS 'teacher_message'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a single enum value; removing it would require
    // recreating the type and rewriting every dependent column. Left as a
    // manual, deliberate operation if ever needed.
  }
}
