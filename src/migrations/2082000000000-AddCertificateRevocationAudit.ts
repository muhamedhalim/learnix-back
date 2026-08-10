import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-019 — a course certificate is valid only while the student holds a
 * valid, non-revoked purchase for that course.
 *
 * Schema (additive only):
 *  - `certificates.revoked_by` / `certificates.revocation_context` record WHO
 *    revoked a certificate and WHY, including the refund/order/payment that
 *    withdrew access. `revoked_at` / `revoke_reason` already existed.
 *  - `certificate_history.revocation_context` carries the same cause onto the
 *    retired-credentials snapshot written when a revoked certificate is
 *    reissued, so the audit trail survives a reissue cycle.
 *
 * Data (backfill): certificates that were issued before this policy was
 * enforced and whose course purchase has since been revoked by a FULLY
 * refunded order are flipped to `revoked`. Nothing is ever deleted — the
 * historical row, its number, and its verification code are all preserved, so
 * public verification keeps returning a definite "revoked" answer rather than
 * "unknown".
 *
 * Deliberately conservative — the backfill only touches a certificate when
 * ALL of the following are true, i.e. only when the cause is reconstructible
 * from durable financial records rather than guessed:
 *   1. it is currently `issued`;
 *   2. the student has NO valid purchase of that course left (so a course
 *      re-bought after a refund correctly keeps its certificate); and
 *   3. at least one of their revoked purchases of that course belongs to an
 *      order whose status is `refunded` (a completed FULL refund) — the
 *      order id and its succeeded refund are recorded in the context.
 *
 * DOCUMENTED LIMITATION: a certificate whose student never had a
 * `package_purchases` row at all (historically force-issued by an admin
 * before eligibility was enforced) is left ISSUED and untouched. There is no
 * financial record from which to reconstruct whether it was ever paid for, and
 * inventing one — or revoking on suspicion — would be worse than leaving a
 * documented, queryable gap. Such rows are reported in the migration log.
 */
export class AddCertificateRevocationAudit2082000000000 implements MigrationInterface {
  public name = 'AddCertificateRevocationAudit2082000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "revoked_by" uuid`);
    await q.query(
      `ALTER TABLE "certificates" ADD COLUMN IF NOT EXISTS "revocation_context" jsonb`,
    );
    await q.query(
      `ALTER TABLE "certificate_history" ADD COLUMN IF NOT EXISTS "revocation_context" jsonb`,
    );

    // Existing manual revocations predate the context column — label them so
    // "no context" unambiguously means "not yet classified" nowhere.
    await q.query(`
      UPDATE "certificates"
         SET "revocation_context" = jsonb_build_object('source', 'manual')
       WHERE "status" = 'revoked' AND "revocation_context" IS NULL
    `);

    const backfilled = (await q.query(`
      WITH refunded_course_access AS (
        SELECT
          pp.student_id,
          pp.package_id,
          (array_agg(o.id ORDER BY o.updated_at DESC NULLS LAST, o.id))[1] AS order_id,
          (array_agg(pp.id ORDER BY pp.purchased_at DESC))[1]              AS package_purchase_id,
          (array_agg(pp.payment_id ORDER BY pp.purchased_at DESC))[1]      AS payment_id
        FROM package_purchases pp
        JOIN orders o
          ON o.payment_id = pp.payment_id
         AND o.student_id = pp.student_id
         AND o.status = 'refunded'
        WHERE pp.revoked_at IS NOT NULL
        GROUP BY pp.student_id, pp.package_id
      )
      UPDATE "certificates" c
         SET "status"             = 'revoked',
             "is_public"          = false,
             "revoked_at"         = COALESCE(c."revoked_at", now()),
             "revoke_reason"      = COALESCE(
               c."revoke_reason",
               'refund:full_refund_backfill'
             ),
             "revocation_context" = jsonb_strip_nulls(jsonb_build_object(
               'source', 'refund_backfill',
               'order_id', r.order_id::text,
               'payment_id', r.payment_id::text,
               'package_purchase_id', r.package_purchase_id::text,
               'refund_id', (
                 SELECT rf.id::text FROM refunds rf
                  WHERE rf.order_id = r.order_id AND rf.status = 'succeeded'
                  ORDER BY rf.completed_at DESC NULLS LAST
                  LIMIT 1
               )
             ))
        FROM refunded_course_access r
       WHERE c."student_id" = r.student_id
         AND c."package_id" = r.package_id
         AND c."status" = 'issued'
         AND NOT EXISTS (
           SELECT 1 FROM package_purchases live
            WHERE live.student_id = c."student_id"
              AND live.package_id = c."package_id"
              AND live.revoked_at IS NULL
         )
      RETURNING c."id"
    `)) as { id: string }[];

    const orphans = (await q.query(`
      SELECT COUNT(*)::int AS count
        FROM "certificates" c
       WHERE c."status" = 'issued'
         AND NOT EXISTS (
           SELECT 1 FROM package_purchases pp
            WHERE pp.student_id = c."student_id" AND pp.package_id = c."package_id"
         )
    `)) as [{ count: number }];

    // eslint-disable-next-line no-console
    console.log(
      `[DEF-019] Revoked ${backfilled.length} certificate(s) whose course purchase was fully refunded. ` +
        `${orphans[0].count} certificate(s) have no purchase record at all and were left untouched (see migration docblock).`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    // Restore only the rows this migration itself revoked; a manual revocation
    // or a genuine post-deploy refund revocation must survive a rollback.
    await q.query(`
      UPDATE "certificates"
         SET "status" = 'issued',
             "revoked_at" = NULL,
             "revoke_reason" = NULL
       WHERE "revocation_context" ->> 'source' = 'refund_backfill'
    `);
    await q.query(
      `ALTER TABLE "certificate_history" DROP COLUMN IF EXISTS "revocation_context"`,
    );
    await q.query(`ALTER TABLE "certificates" DROP COLUMN IF EXISTS "revocation_context"`);
    await q.query(`ALTER TABLE "certificates" DROP COLUMN IF EXISTS "revoked_by"`);
  }
}
