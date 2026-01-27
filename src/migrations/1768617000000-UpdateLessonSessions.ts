import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableIndex } from 'typeorm';

export class UpdateLessonSessions1768617000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rename watch_percentage to video_progress_percent and change type to INT
    await queryRunner.changeColumn(
      'lesson_sessions',
      'watch_percentage',
      new TableColumn({
        name: 'video_progress_percent',
        type: 'int',
        default: 0,
      }),
    );

    // Drop is_completed column and its index
    await queryRunner.dropIndex(
      'lesson_sessions',
      'IDX_lesson_sessions_completed',
    );
    await queryRunner.dropColumn('lesson_sessions', 'is_completed');

    // Add composite index
    await queryRunner.createIndex(
      'lesson_sessions',
      new TableIndex({
        name: 'IDX_lesson_sessions_student_lesson_entered',
        columnNames: ['student_id', 'lesson_id', 'entered_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop composite index
    await queryRunner.dropIndex(
      'lesson_sessions',
      'IDX_lesson_sessions_student_lesson_entered',
    );

    // Re-add is_completed column
    await queryRunner.addColumn(
      'lesson_sessions',
      new TableColumn({
        name: 'is_completed',
        type: 'boolean',
        default: false,
      }),
    );

    await queryRunner.createIndex(
      'lesson_sessions',
      new TableIndex({
        name: 'IDX_lesson_sessions_completed',
        columnNames: ['is_completed'],
      }),
    );

    // Rename back and change type
    await queryRunner.changeColumn(
      'lesson_sessions',
      'video_progress_percent',
      new TableColumn({
        name: 'watch_percentage',
        type: 'decimal',
        precision: 5,
        scale: 2,
        default: 0,
      }),
    );
  }
}
