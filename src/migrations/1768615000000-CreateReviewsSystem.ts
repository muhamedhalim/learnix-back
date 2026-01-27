import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableCheck, TableIndex, TableUnique } from 'typeorm';

export class CreateReviewsSystem1768615000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create teacher_reviews table
    await queryRunner.createTable(
      new Table({
        name: 'teacher_reviews',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'teacher_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'student_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'rating',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'comment',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
        foreignKeys: [
          {
            columnNames: ['teacher_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['student_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );

    // Add unique constraint
    await queryRunner.createUniqueConstraint(
      'teacher_reviews',
      new TableUnique({
        name: 'UQ_teacher_review_teacher_student',
        columnNames: ['teacher_id', 'student_id'],
      }),
    );

    // Add check constraint for rating
    await queryRunner.createCheckConstraint(
      'teacher_reviews',
      new TableCheck({
        name: 'CHK_teacher_review_rating',
        expression: 'rating >= 1 AND rating <= 5',
      }),
    );

    // Create indexes for teacher_reviews
    await queryRunner.createIndex(
      'teacher_reviews',
      new TableIndex({
        name: 'IDX_teacher_reviews_teacher_id',
        columnNames: ['teacher_id'],
      }),
    );

    await queryRunner.createIndex(
      'teacher_reviews',
      new TableIndex({
        name: 'IDX_teacher_reviews_student_id',
        columnNames: ['student_id'],
      }),
    );

    await queryRunner.createIndex(
      'teacher_reviews',
      new TableIndex({
        name: 'IDX_teacher_reviews_rating',
        columnNames: ['rating'],
      }),
    );

    await queryRunner.createIndex(
      'teacher_reviews',
      new TableIndex({
        name: 'IDX_teacher_reviews_created_at',
        columnNames: ['created_at'],
      }),
    );

    // Create lesson_reviews table
    await queryRunner.createTable(
      new Table({
        name: 'lesson_reviews',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'lesson_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'student_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'rating',
            type: 'int',
            isNullable: false,
          },
          {
            name: 'comment',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            onUpdate: 'CURRENT_TIMESTAMP',
          },
        ],
        foreignKeys: [
          {
            columnNames: ['lesson_id'],
            referencedTableName: 'lessons',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['student_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );

    // Add unique constraint
    await queryRunner.createUniqueConstraint(
      'lesson_reviews',
      new TableUnique({
        name: 'UQ_lesson_review_lesson_student',
        columnNames: ['lesson_id', 'student_id'],
      }),
    );

    // Add check constraint for rating
    await queryRunner.createCheckConstraint(
      'lesson_reviews',
      new TableCheck({
        name: 'CHK_lesson_review_rating',
        expression: 'rating >= 1 AND rating <= 5',
      }),
    );

    // Create indexes for lesson_reviews
    await queryRunner.createIndex(
      'lesson_reviews',
      new TableIndex({
        name: 'IDX_lesson_reviews_lesson_id',
        columnNames: ['lesson_id'],
      }),
    );

    await queryRunner.createIndex(
      'lesson_reviews',
      new TableIndex({
        name: 'IDX_lesson_reviews_student_id',
        columnNames: ['student_id'],
      }),
    );

    await queryRunner.createIndex(
      'lesson_reviews',
      new TableIndex({
        name: 'IDX_lesson_reviews_rating',
        columnNames: ['rating'],
      }),
    );

    await queryRunner.createIndex(
      'lesson_reviews',
      new TableIndex({
        name: 'IDX_lesson_reviews_created_at',
        columnNames: ['created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop lesson_reviews
    await queryRunner.dropIndex(
      'lesson_reviews',
      'IDX_lesson_reviews_created_at',
    );
    await queryRunner.dropIndex('lesson_reviews', 'IDX_lesson_reviews_rating');
    await queryRunner.dropIndex(
      'lesson_reviews',
      'IDX_lesson_reviews_student_id',
    );
    await queryRunner.dropIndex(
      'lesson_reviews',
      'IDX_lesson_reviews_lesson_id',
    );
    await queryRunner.dropCheckConstraint(
      'lesson_reviews',
      'CHK_lesson_review_rating',
    );
    await queryRunner.dropUniqueConstraint(
      'lesson_reviews',
      'UQ_lesson_review_lesson_student',
    );
    await queryRunner.dropTable('lesson_reviews');

    // Drop teacher_reviews
    await queryRunner.dropIndex(
      'teacher_reviews',
      'IDX_teacher_reviews_created_at',
    );
    await queryRunner.dropIndex(
      'teacher_reviews',
      'IDX_teacher_reviews_rating',
    );
    await queryRunner.dropIndex(
      'teacher_reviews',
      'IDX_teacher_reviews_student_id',
    );
    await queryRunner.dropIndex(
      'teacher_reviews',
      'IDX_teacher_reviews_teacher_id',
    );
    await queryRunner.dropCheckConstraint(
      'teacher_reviews',
      'CHK_teacher_review_rating',
    );
    await queryRunner.dropUniqueConstraint(
      'teacher_reviews',
      'UQ_teacher_review_teacher_student',
    );
    await queryRunner.dropTable('teacher_reviews');
  }
}
