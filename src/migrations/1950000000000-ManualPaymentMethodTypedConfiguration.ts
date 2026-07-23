import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the canonical, typed manual-payment configuration without removing the
 * deployed localized/destination columns. Conflicting legacy localized values
 * are retained in metadata for an administrator to review.
 */
export class ManualPaymentMethodTypedConfiguration1950000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE "manual_payment_methods"
        ADD COLUMN IF NOT EXISTS "configuration" jsonb NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS "internal_notes" text,
        ADD COLUMN IF NOT EXISTS "legacy_content_metadata" jsonb,
        ADD COLUMN IF NOT EXISTS "transaction_reference_required" boolean NOT NULL DEFAULT true
    `);
    await q.query(`
      UPDATE "manual_payment_methods"
      SET "transaction_reference_required" = COALESCE("reference_required", true)
      WHERE "transaction_reference_required" IS DISTINCT FROM COALESCE("reference_required", true)
    `);

    // The legacy translation columns remain in place, but no longer enforce a
    // duplicate canonical value for every new method.
    await q.query(`
      ALTER TABLE "manual_payment_methods"
        ALTER COLUMN "name_ar" DROP NOT NULL,
        ALTER COLUMN "instructions_ar" DROP NOT NULL
    `);

    await q.query(`
      UPDATE "manual_payment_methods"
      SET "type" = CASE lower(trim("type"))
        WHEN 'bank' THEN 'bank_transfer'
        WHEN 'bank-transfer' THEN 'bank_transfer'
        WHEN 'bank_transfer' THEN 'bank_transfer'
        WHEN 'instapay' THEN 'instapay'
        WHEN 'insta_pay' THEN 'instapay'
        WHEN 'mobile_wallet' THEN 'mobile_wallet'
        WHEN 'mobile-wallet' THEN 'mobile_wallet'
        WHEN 'wallet' THEN 'mobile_wallet'
        WHEN 'cash' THEN 'cash'
        ELSE 'custom'
      END
    `);

    await q.query(`
      UPDATE "manual_payment_methods"
      SET
        "legacy_content_metadata" = CASE
          WHEN COALESCE(trim("name"), '') <> ''
           AND COALESCE(trim("name_ar"), '') <> ''
           AND trim("name") <> trim("name_ar")
          THEN jsonb_strip_nulls(jsonb_build_object(
            'manual_review_required', true,
            'legacy_name_ar', "name_ar",
            'legacy_instructions_ar', CASE
              WHEN COALESCE(trim("instructions"), '') <> ''
               AND COALESCE(trim("instructions_ar"), '') <> ''
               AND trim("instructions") <> trim("instructions_ar")
              THEN "instructions_ar" ELSE NULL END
          ))
          WHEN COALESCE(trim("instructions"), '') <> ''
           AND COALESCE(trim("instructions_ar"), '') <> ''
           AND trim("instructions") <> trim("instructions_ar")
          THEN jsonb_build_object(
            'manual_review_required', true,
            'legacy_instructions_ar', "instructions_ar"
          )
          ELSE NULL
        END,
        "name" = CASE
          WHEN COALESCE(trim("name"), '') = '' AND COALESCE(trim("name_ar"), '') <> '' THEN trim("name_ar")
          ELSE "name" END,
        "instructions" = CASE
          WHEN COALESCE(trim("instructions"), '') = '' AND COALESCE(trim("instructions_ar"), '') <> '' THEN trim("instructions_ar")
          ELSE "instructions" END
    `);

    await q.query(`
      UPDATE "manual_payment_methods"
      SET "configuration" = CASE "type"
        WHEN 'bank_transfer' THEN jsonb_strip_nulls(jsonb_build_object(
          'bank_name', COALESCE("destination_details"->>'bank_name', "destination_details"->>'bank'),
          'branch_name', "destination_details"->>'branch_name',
          'account_number', COALESCE("destination_details"->>'account_number', "destination_details"->>'account'),
          'iban', "destination_details"->>'iban',
          'swift_code', "destination_details"->>'swift_code'
        ))
        WHEN 'instapay' THEN jsonb_strip_nulls(jsonb_build_object(
          'instapay_address', COALESCE("destination_details"->>'instapay_address', "destination_details"->>'instapay', "destination_details"->>'address'),
          'phone_number', COALESCE("destination_details"->>'phone_number', "destination_details"->>'phone')
        ))
        WHEN 'mobile_wallet' THEN jsonb_strip_nulls(jsonb_build_object(
          'provider', "destination_details"->>'provider',
          'phone_number', COALESCE("destination_details"->>'phone_number', "destination_details"->>'phone', "destination_details"->>'wallet'),
          'wallet_holder_name', COALESCE("destination_details"->>'wallet_holder_name', "recipient_name")
        ))
        WHEN 'cash' THEN jsonb_strip_nulls(jsonb_build_object(
          'location_name', COALESCE("destination_details"->>'location_name', "destination_details"->>'location'),
          'address', "destination_details"->>'address',
          'working_hours', "destination_details"->>'working_hours'
        ))
        ELSE jsonb_strip_nulls(jsonb_build_object(
          'label', COALESCE("destination_details"->>'label', "destination_details"->>'destination_key', 'Payment details'),
          'value', COALESCE("destination_details"->>'value', "destination_details"->>'destination_value', "destination_details"->>'account', "destination_details"->>'phone', "destination_details"->>'address')
        ))
      END
      WHERE "configuration" = '{}'::jsonb
    `);

    await q.query(`
      ALTER TABLE "manual_payment_methods"
        ADD CONSTRAINT "CHK_manual_payment_method_type"
        CHECK ("type" IN ('bank_transfer','instapay','mobile_wallet','cash','custom'))
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "manual_payment_methods" DROP CONSTRAINT IF EXISTS "CHK_manual_payment_method_type"`,
    );
    // Existing legacy columns are intentionally left intact; rollback only
    // removes additions from this migration.
    await q.query(`
      ALTER TABLE "manual_payment_methods"
        DROP COLUMN IF EXISTS "transaction_reference_required",
        DROP COLUMN IF EXISTS "legacy_content_metadata",
        DROP COLUMN IF EXISTS "internal_notes",
        DROP COLUMN IF EXISTS "configuration"
    `);
  }
}
