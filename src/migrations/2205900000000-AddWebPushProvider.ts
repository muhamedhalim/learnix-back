import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registers `webpush` as a push provider next to `fcm`. A Web Push token is the browser's
 * PushSubscription JSON (endpoint + keys), stored in the existing `token` column.
 */
export class AddWebPushProvider2205900000000 implements MigrationInterface {
  public name = 'AddWebPushProvider2205900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "push_devices_provider_enum" ADD VALUE IF NOT EXISTS 'webpush'`);
  }

  public down(): Promise<void> {
    // PostgreSQL cannot drop an enum value. An unused value is harmless, so rolling back is a no-op.
    return Promise.resolve();
  }
}
