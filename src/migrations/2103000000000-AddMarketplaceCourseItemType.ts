import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 6 (Orders/Payments). The marketplace reuses the platform's existing
 * shared `payments` table and gateway integration rather than a second one
 * (research finding: Paymob's webhook destination is fixed per merchant/
 * integration, not settable per transaction — `GatewayFinancialStateMachineService.apply()`
 * is the one place a successful/refunded webhook is turned into fulfillment,
 * for every purchase type). `item_type`/`item_id` is the entity's own
 * existing polymorphic pair (`payment.entity.ts`) — this just adds the one
 * new value a marketplace course purchase's `Payment` row carries, with
 * `item_id` = `MarketplaceOrder.id`. Purely additive: the four existing
 * values are untouched, so no existing payment row or query is affected.
 *
 * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction.
 */
export class AddMarketplaceCourseItemType2103000000000 implements MigrationInterface {
  public name = 'AddMarketplaceCourseItemType2103000000000';
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "payments_item_type_enum" ADD VALUE IF NOT EXISTS 'marketplace_course';`);
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a single enum value. Rolling back the Payment
    // rows that used it (if any) is an operational decision, not a schema
    // change this migration can safely automate.
  }
}
