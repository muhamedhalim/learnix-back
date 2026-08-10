import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { EntityManager, Repository, type SelectQueryBuilder } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationStatus } from '../notifications/entities/notification-status.enum';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { Certificate, type CertificateRevocationContext } from './entities/certificate.entity';
import { CertificateHistory } from './entities/certificate-history.entity';
import { CertificateStatus } from './entities/certificate-status.enum';

/**
 * The ONE definition of "this purchase still entitles its student to a course
 * certificate", expressed as SQL over a `package_purchases` alias so the
 * row-level check and the set-level (bulk / auto-issue) queries can never
 * drift apart.
 *
 * Two conditions, both drawn from the access rules the product already
 * enforces elsewhere — no new expiry semantics are invented here:
 *
 *  1. the purchase itself has not been revoked (`revoked_at IS NULL`), which is
 *     exactly how `CoursePreviewService` decides course access today; and
 *  2. the canonical `entitlements` row that finalization wrote alongside it is
 *     still ACTIVE and unexpired — mirroring `EntitlementsService.hasItemAccess`.
 *     Package entitlements are granted with `expires_at = NULL` today
 *     (`PaymentFinalizationService.grantEntitlement` only dates lesson access),
 *     so the expiry clause is a no-op for current data and exists purely so
 *     certificate eligibility keeps tracking the entitlement rule rather than
 *     silently diverging from it. Legacy purchases with no entitlement row at
 *     all fall back to condition 1 alone.
 */
export const ACTIVE_PACKAGE_PURCHASE_SQL = (alias: string): string => `
  ${alias}.revoked_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM entitlements ent
    WHERE ent.student_id = ${alias}.student_id
      AND ent.item_type = 'package'
      AND ent.item_id = ${alias}.package_id
      AND ent.payment_id = ${alias}.payment_id
      AND (
        ent.status <> 'active'
        OR (ent.expires_at IS NOT NULL AND ent.expires_at <= now())
      )
  )
`;

/** What caused a course's access to be withdrawn, for the revocation audit. */
export interface CourseAccessRevocation {
  studentId: string;
  packageId: string;
  reason: string;
  context: CertificateRevocationContext;
  /** Actor id; omit for platform-automatic revocation (e.g. the refund pipeline). */
  actorId?: string | null;
}

/**
 * Owns the purchase ↔ certificate contract in both directions (DEF-019):
 * who may RECEIVE a certificate, and whose certificate must DIE when the
 * underlying course access is withdrawn.
 *
 * Every issuance path in `CertificatesService` — manual, admin/teacher bulk,
 * lesson-completion auto-issue, and the retry cron — funnels through
 * `assertEligible` / `lockActivePurchase` here, so there is exactly one
 * eligibility rule in the system rather than a copy per path.
 */
@Injectable()
export class CertificateEligibilityService {
  private readonly logger = new Logger(CertificateEligibilityService.name);

  constructor(
    @InjectRepository(PackagePurchase)
    private readonly packagePurchases: Repository<PackagePurchase>,
  ) {}

  /** Narrow an existing `package_purchases` query to still-valid purchases. */
  public applyActivePurchase<T extends object>(
    query: SelectQueryBuilder<T>,
    alias: string,
  ): SelectQueryBuilder<T> {
    return query.andWhere(`(${ACTIVE_PACKAGE_PURCHASE_SQL(alias)})`);
  }

  /**
   * The student's current valid purchase of a course, or null. When several
   * exist (a course re-bought after a refund) the newest wins, deterministically.
   */
  public async findActivePurchase(
    studentId: string,
    packageId: string,
    manager?: EntityManager,
  ): Promise<PackagePurchase | null> {
    const repository = manager ? manager.getRepository(PackagePurchase) : this.packagePurchases;
    const query = repository
      .createQueryBuilder('pp')
      .where('pp.student_id = :studentId', { studentId })
      .andWhere('pp.package_id = :packageId', { packageId })
      .orderBy('pp.purchased_at', 'DESC')
      .addOrderBy('pp.id', 'DESC');
    this.applyActivePurchase(query, 'pp');
    return query.getOne();
  }

  /**
   * Same as `findActivePurchase`, but takes a row lock so a concurrent full
   * refund cannot revoke the purchase between the check and the certificate
   * INSERT. `RefundsService.revokeAccess` UPDATEs the same row inside its own
   * transaction, so whichever transaction gets the lock first wins and the
   * loser re-reads the committed outcome instead of racing it.
   *
   * Deliberately two steps — resolve a candidate, lock it by id, then
   * RE-EVALUATE the canonical predicate — rather than bolting `FOR UPDATE`
   * onto the eligibility query itself. The predicate spans a correlated
   * subquery over `entitlements`, so making the lock and the recheck separate,
   * explicit statements keeps the guarantee readable and independent of how a
   * given Postgres version re-checks a locked row's WHERE clause.
   */
  public async lockActivePurchase(
    manager: EntityManager,
    studentId: string,
    packageId: string,
  ): Promise<PackagePurchase | null> {
    const candidate = await this.findActivePurchase(studentId, packageId, manager);
    if (!candidate) return null;
    await manager
      .createQueryBuilder(PackagePurchase, 'pp')
      .setLock('pessimistic_write')
      .where('pp.id = :id', { id: candidate.id })
      .getOne();
    // Re-read through the canonical predicate now that the row is locked: if a
    // refund committed while we waited, this returns null (or a different,
    // still-valid purchase) rather than the stale pre-refund snapshot.
    return this.findActivePurchase(studentId, packageId, manager);
  }

  /** Throw unless the student currently holds a valid, non-revoked course purchase. */
  public async assertEligible(
    studentId: string,
    packageId: string,
    manager?: EntityManager,
  ): Promise<PackagePurchase> {
    const purchase = await this.findActivePurchase(studentId, packageId, manager);
    if (!purchase) throw this.ineligible();
    return purchase;
  }

  /**
   * The rejection every issuance path shares. 422 rather than 403: the caller
   * may well be an admin with every permission — the *student* is the one who
   * does not hold a course entitlement to certify.
   */
  public ineligible(): UnprocessableEntityException {
    return new UnprocessableEntityException(
      biBody(
        'This student does not hold a valid, non-revoked purchase for this course — a certificate cannot be issued.',
        'لا يملك هذا الطالب شراءً ساريًا وغير ملغى لهذه الدورة — لا يمكن إصدار الشهادة.',
      ),
    );
  }

  /* ===================== Revocation on access withdrawal ===================== */

  /**
   * Revoke the course certificate whose access has just been withdrawn.
   *
   * Runs inside the caller's transaction (the refund transaction), AFTER the
   * purchase/entitlement rows have already been revoked in that same
   * transaction — so the certificate is never revoked before the refund is
   * finalized, and never survives one that is.
   *
   * Returns the certificate it actually revoked, or null when there was
   * nothing to revoke — so callers can log/audit exactly once. Idempotent in
   * two ways: an already-REVOKED certificate is left untouched (replaying a
   * refund completion writes no second history row, event, or audit entry),
   * and a student who still holds ANOTHER valid purchase of the same course
   * keeps their certificate — the policy is "valid while entitled", not "dead
   * on any refund".
   *
   * The historical row is preserved: status flips to REVOKED and the retired
   * credentials are snapshotted into `certificate_history`. Nothing is deleted.
   */
  public async revokeForWithdrawnAccess(
    manager: EntityManager,
    revocation: CourseAccessRevocation,
  ): Promise<Certificate | null> {
    const certificate = await manager.findOne(Certificate, {
      where: { student_id: revocation.studentId, package_id: revocation.packageId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!certificate) return null;
    if (certificate.status === CertificateStatus.REVOKED) return null;
    if (await this.findActivePurchase(revocation.studentId, revocation.packageId, manager)) {
      return null;
    }

    const revokedAt = new Date();
    await manager.save(
      CertificateHistory,
      manager.create(CertificateHistory, {
        certificate_id: certificate.id,
        certificate_number: certificate.certificate_number,
        verification_code: certificate.verification_code,
        status: CertificateStatus.REVOKED,
        revoked_at: revokedAt,
        revoke_reason: revocation.reason,
        reissued_by: null,
        revocation_context: revocation.context,
      }),
    );

    certificate.status = CertificateStatus.REVOKED;
    certificate.revoked_at = revokedAt;
    certificate.revoke_reason = revocation.reason;
    certificate.revoked_by = revocation.actorId ?? null;
    certificate.revocation_context = revocation.context;
    // Drop it out of the public gallery in the same write.
    certificate.is_public = false;
    const saved = await manager.save(Certificate, certificate);

    await this.notifyRevoked(manager, saved, revocation);
    this.logger.log(
      `Certificate ${saved.certificate_number} revoked — course access withdrawn (${revocation.reason})`,
    );
    return saved;
  }

  /**
   * Reuses the platform's existing in-app notification table directly (the same
   * pattern `RefundsService.notification` uses) so the notice is written inside
   * the refund transaction and deduped by key. No new channel is introduced.
   */
  private async notifyRevoked(
    manager: EntityManager,
    certificate: Certificate,
    revocation: CourseAccessRevocation,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values({
        dedupe_key: `certificate:${certificate.id}:revoked`,
        user_id: certificate.student_id,
        type: NotificationType.CUSTOM,
        title: 'Certificate revoked',
        message: `Your certificate for "${certificate.course_title}" was revoked because access to the course was withdrawn.`,
        data: {
          certificate_id: certificate.id,
          certificate_number: certificate.certificate_number,
          ...revocation.context,
        },
        is_read: false,
        sent_at: new Date(),
        read_at: null,
        sms_sent: false,
        sms_to: null,
        status: NotificationStatus.SENT,
        attempts: 0,
        error_message: null,
        delivered_at: null,
      } as never)
      .orIgnore()
      .execute();
  }
}
