import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateComplaintsSystem1768616000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'complaints',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'student_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'type',
            type: 'enum',
            enum: ['teacher', 'lesson', 'technical'],
            isNullable: false,
          },
          {
            name: 'target_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'subject',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['pending', 'in_progress', 'resolved'],
            default: "'pending'",
          },
          {
            name: 'admin_response',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'admin_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'responded_at',
            type: 'timestamp',
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
          {
            name: 'deleted_at',
            type: 'timestamp',
            isNullable: true,
          },
        ],
        foreignKeys: [
          {
            columnNames: ['student_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            columnNames: ['admin_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
    );

    await queryRunner.createIndex(
      'complaints',
      new TableIndex({
        name: 'IDX_complaints_student_id',
        columnNames: ['student_id'],
      }),
    );

    await queryRunner.createIndex(
      'complaints',
      new TableIndex({
        name: 'IDX_complaints_status',
        columnNames: ['status'],
      }),
    );

    await queryRunner.createIndex(
      'complaints',
      new TableIndex({
        name: 'IDX_complaints_type',
        columnNames: ['type'],
      }),
    );

    await queryRunner.createIndex(
      'complaints',
      new TableIndex({
        name: 'IDX_complaints_created_at',
        columnNames: ['created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('complaints', 'IDX_complaints_created_at');
    await queryRunner.dropIndex('complaints', 'IDX_complaints_type');
    await queryRunner.dropIndex('complaints', 'IDX_complaints_status');
    await queryRunner.dropIndex('complaints', 'IDX_complaints_student_id');
    await queryRunner.dropTable('complaints');
  }
}
