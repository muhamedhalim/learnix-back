import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableIndex } from 'typeorm';

export class AddPasswordResetFields1768627000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('users', [
      new TableColumn({
        name: 'password_reset_token',
        type: 'text',
        isNullable: true,
      }),
      new TableColumn({
        name: 'password_reset_token_id',
        type: 'varchar',
        length: '64',
        isNullable: true,
      }),
      new TableColumn({
        name: 'password_reset_expires_at',
        type: 'timestamp',
        isNullable: true,
      }),
    ]);

    await queryRunner.createIndex(
      'users',
      new TableIndex({
        name: 'IDX_users_password_reset_token_id',
        columnNames: ['password_reset_token_id'],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropIndex('users', 'IDX_users_password_reset_token_id');
    await queryRunner.dropColumns('users', [
      'password_reset_token',
      'password_reset_token_id',
      'password_reset_expires_at',
    ]);
  }
}
