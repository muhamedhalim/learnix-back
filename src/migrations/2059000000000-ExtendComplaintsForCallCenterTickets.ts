import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';

/**
 * Evolves the existing complaints aggregate into the Call Center ticket
 * foundation. It is additive: student ownership and the legacy admin-response
 * columns remain so current application paths continue to work.
 */
export class ExtendComplaintsForCallCenterTickets2059000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const status of [
      'new',
      'waiting_for_user',
      'waiting_for_internal_review',
      'escalated',
      'closed',
      'reopened',
    ]) {
      await queryRunner.query(`ALTER TYPE "complaints_status_enum" ADD VALUE IF NOT EXISTS '${status}'`);
    }

    await queryRunner.changeColumn('complaints', 'student_id', new TableColumn({
      name: 'student_id', type: 'uuid', isNullable: true,
    }));
    await queryRunner.addColumns('complaints', [
      new TableColumn({ name: 'complainant_id', type: 'uuid', isNullable: true }),
      new TableColumn({ name: 'complainant_role', type: 'varchar', length: '20', isNullable: true }),
      new TableColumn({ name: 'ticket_number', type: 'varchar', length: '32', isNullable: true }),
      new TableColumn({ name: 'assigned_agent_id', type: 'uuid', isNullable: true }),
      new TableColumn({ name: 'first_response_at', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'first_response_due_at', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'resolution_due_at', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'resolved_at', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'closed_at', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'escalated_at', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'resolution', type: 'text', isNullable: true }),
      new TableColumn({ name: 'close_reason', type: 'text', isNullable: true }),
      new TableColumn({ name: 'reopen_count', type: 'int', default: '0' }),
      new TableColumn({ name: 'version', type: 'int', default: '1' }),
    ]);
    await queryRunner.query('CREATE SEQUENCE "complaint_ticket_number_seq" START WITH 1 INCREMENT BY 1');
    await queryRunner.query(`
      UPDATE "complaints"
      SET "complainant_id" = "student_id", "complainant_role" = 'student',
          "ticket_number" = 'CC-' || EXTRACT(YEAR FROM "created_at")::text || '-' || LPAD(nextval('"complaint_ticket_number_seq"')::text, 6, '0')
      WHERE "complainant_id" IS NULL
    `);
    await queryRunner.changeColumn('complaints', 'complainant_id', new TableColumn({
      name: 'complainant_id', type: 'uuid', isNullable: false,
    }));
    await queryRunner.changeColumn('complaints', 'complainant_role', new TableColumn({
      name: 'complainant_role', type: 'varchar', length: '20', isNullable: false,
    }));
    await queryRunner.changeColumn('complaints', 'ticket_number', new TableColumn({
      name: 'ticket_number', type: 'varchar', length: '32', isNullable: false,
    }));
    await queryRunner.createForeignKeys('complaints', [
      new TableForeignKey({
        name: 'FK_complaints_complainant_id', columnNames: ['complainant_id'],
        referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'RESTRICT',
      }),
      new TableForeignKey({
        name: 'FK_complaints_assigned_agent_id', columnNames: ['assigned_agent_id'],
        referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'SET NULL',
      }),
    ]);
    await queryRunner.createIndices('complaints', [
      new TableIndex({ name: 'IDX_complaints_ticket_number', columnNames: ['ticket_number'], isUnique: true }),
      new TableIndex({ name: 'IDX_complaints_complainant_id', columnNames: ['complainant_id'] }),
      new TableIndex({ name: 'IDX_complaints_assigned_agent_id', columnNames: ['assigned_agent_id'] }),
    ]);

    await queryRunner.createTable(new Table({
      name: 'complaint_messages',
      columns: [
        { name: 'id', type: 'uuid', isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'complaint_id', type: 'uuid' },
        { name: 'author_id', type: 'uuid', isNullable: true },
        { name: 'kind', type: 'enum', enum: ['complainant_message', 'agent_reply', 'internal_note'] },
        { name: 'body', type: 'text' },
        { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
      ],
      foreignKeys: [
        { columnNames: ['complaint_id'], referencedTableName: 'complaints', referencedColumnNames: ['id'], onDelete: 'CASCADE' },
        { columnNames: ['author_id'], referencedTableName: 'users', referencedColumnNames: ['id'], onDelete: 'SET NULL' },
      ],
    }));
    await queryRunner.createIndex('complaint_messages', new TableIndex({
      name: 'IDX_complaint_messages_complaint_created_at', columnNames: ['complaint_id', 'created_at'],
    }));

    await queryRunner.createTable(new Table({
      name: 'complaint_status_periods',
      columns: [
        { name: 'id', type: 'uuid', isPrimary: true, generationStrategy: 'uuid', default: 'gen_random_uuid()' },
        { name: 'complaint_id', type: 'uuid' },
        { name: 'status', type: 'enum', enum: ['new', 'pending', 'in_progress', 'waiting_for_user', 'waiting_for_internal_review', 'escalated', 'resolved', 'closed', 'reopened'] },
        { name: 'started_at', type: 'timestamp' },
        { name: 'ended_at', type: 'timestamp', isNullable: true },
        { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
      ],
      foreignKeys: [{
        columnNames: ['complaint_id'], referencedTableName: 'complaints', referencedColumnNames: ['id'], onDelete: 'CASCADE',
      }],
    }));
    await queryRunner.createIndex('complaint_status_periods', new TableIndex({
      name: 'IDX_complaint_status_periods_complaint_started_at', columnNames: ['complaint_id', 'started_at'],
    }));
    await queryRunner.query(`
      INSERT INTO "complaint_status_periods" ("complaint_id", "status", "started_at", "ended_at")
      SELECT "id", "status"::text::"complaint_status_periods_status_enum", "created_at", NULL FROM "complaints"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Preserve existing complaints and their original schema. Down intentionally
    // removes only data introduced by this phase.
    await queryRunner.dropTable('complaint_status_periods');
    await queryRunner.dropTable('complaint_messages');
    await queryRunner.dropIndex('complaints', 'IDX_complaints_assigned_agent_id');
    await queryRunner.dropIndex('complaints', 'IDX_complaints_complainant_id');
    await queryRunner.dropIndex('complaints', 'IDX_complaints_ticket_number');
    await queryRunner.dropForeignKey('complaints', 'FK_complaints_assigned_agent_id');
    await queryRunner.dropForeignKey('complaints', 'FK_complaints_complainant_id');
    await queryRunner.dropColumns('complaints', [
      'version', 'reopen_count', 'close_reason', 'resolution', 'escalated_at', 'closed_at', 'resolved_at',
      'resolution_due_at', 'first_response_due_at', 'first_response_at', 'assigned_agent_id', 'ticket_number',
      'complainant_role', 'complainant_id',
    ]);
    await queryRunner.changeColumn('complaints', 'student_id', new TableColumn({
      name: 'student_id', type: 'uuid', isNullable: false,
    }));
    await queryRunner.query('DROP SEQUENCE "complaint_ticket_number_seq"');
    // PostgreSQL enum values are retained on rollback because removing an enum
    // value is unsafe once production rows may have used it.
  }
}
