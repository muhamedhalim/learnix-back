import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableIndex } from 'typeorm';

export class CreateCommentsSystem1768614000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create comments table
    await queryRunner.createTable(
      new Table({
        name: 'comments',
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
            name: 'comment_text',
            type: 'text',
            isNullable: false,
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
          {
            name: 'deleted_at',
            type: 'timestamp',
            isNullable: true,
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

    // Create indexes for comments
    await queryRunner.createIndex(
      'comments',
      new TableIndex({
        name: 'IDX_comments_lesson_id',
        columnNames: ['lesson_id'],
      }),
    );

    await queryRunner.createIndex(
      'comments',
      new TableIndex({
        name: 'IDX_comments_student_id',
        columnNames: ['student_id'],
      }),
    );

    await queryRunner.createIndex(
      'comments',
      new TableIndex({
        name: 'IDX_comments_created_at',
        columnNames: ['created_at'],
      }),
    );

    await queryRunner.createIndex(
      'comments',
      new TableIndex({
        name: 'IDX_comments_lesson_created',
        columnNames: ['lesson_id', 'created_at'],
      }),
    );

    // Create comment_replies table
    await queryRunner.createTable(
      new Table({
        name: 'comment_replies',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'comment_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'teacher_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'reply_text',
            type: 'text',
            isNullable: false,
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
            columnNames: ['comment_id'],
            referencedTableName: 'comments',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['teacher_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
    );

    // Create indexes for comment_replies
    await queryRunner.createIndex(
      'comment_replies',
      new TableIndex({
        name: 'IDX_comment_replies_comment_id',
        columnNames: ['comment_id'],
      }),
    );

    await queryRunner.createIndex(
      'comment_replies',
      new TableIndex({
        name: 'IDX_comment_replies_teacher_id',
        columnNames: ['teacher_id'],
      }),
    );

    await queryRunner.createIndex(
      'comment_replies',
      new TableIndex({
        name: 'IDX_comment_replies_created_at',
        columnNames: ['created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.dropIndex(
      'comment_replies',
      'IDX_comment_replies_created_at',
    );
    await queryRunner.dropIndex(
      'comment_replies',
      'IDX_comment_replies_teacher_id',
    );
    await queryRunner.dropIndex(
      'comment_replies',
      'IDX_comment_replies_comment_id',
    );

    // Drop tables
    await queryRunner.dropTable('comment_replies');

    await queryRunner.dropIndex('comments', 'IDX_comments_lesson_created');
    await queryRunner.dropIndex('comments', 'IDX_comments_created_at');
    await queryRunner.dropIndex('comments', 'IDX_comments_student_id');
    await queryRunner.dropIndex('comments', 'IDX_comments_lesson_id');

    await queryRunner.dropTable('comments');
  }
}
