import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableIndex } from 'typeorm';

/**
 * Adds metadata for private Call Center ticket evidence. Object bytes remain
 * in the existing private storage provider; this table stores only the opaque
 * key required by an authorized streaming endpoint.
 */
export class AddComplaintAttachments2060000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'complaint_attachments',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          { name: 'complaint_id', type: 'uuid' },
          { name: 'uploader_id', type: 'uuid', isNullable: true },
          { name: 'storage_key', type: 'varchar', length: '500' },
          { name: 'original_filename', type: 'varchar', length: '255' },
          { name: 'mime_type', type: 'varchar', length: '128' },
          { name: 'size', type: 'bigint' },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
        foreignKeys: [
          {
            name: 'FK_complaint_attachments_complaint_id',
            columnNames: ['complaint_id'],
            referencedTableName: 'complaints',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
          {
            name: 'FK_complaint_attachments_uploader_id',
            columnNames: ['uploader_id'],
            referencedTableName: 'users',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
    );
    await queryRunner.createIndex(
      'complaint_attachments',
      new TableIndex({
        name: 'IDX_complaint_attachments_complaint_created_at',
        columnNames: ['complaint_id', 'created_at'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('complaint_attachments');
  }
}
