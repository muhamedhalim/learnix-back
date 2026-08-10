import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

import request from 'supertest';
import type { DataSource } from 'typeorm';

import { CertificatesService } from '../../src/certificates/certificates.service';
import { Certificate } from '../../src/certificates/entities/certificate.entity';
import { CertificateAutoIssuanceFailure } from '../../src/certificates/entities/certificate-auto-issuance-failure.entity';
import { CertificateHistory } from '../../src/certificates/entities/certificate-history.entity';
import { CertificateStatus } from '../../src/certificates/entities/certificate-status.enum';
import { CertificateTemplate } from '../../src/certificates/entities/certificate-template.entity';
import { CertificateTemplateStatus } from '../../src/certificates/entities/certificate-template-status.enum';
import { Lesson } from '../../src/lessons/entities/lesson.entity';
import { ProgressService } from '../../src/lessons/progress.service';
import { CourseStatus } from '../../src/packages/entities/course-status.enum';
import { PackagesService } from '../../src/packages/packages.service';
import {
  CollectionParty,
  Entitlement,
  EntitlementStatus,
  ItemType,
  Order,
  OrderStatus,
  PackagePurchase,
  Payment,
  PaymentAuditLog,
  PaymentChannel,
  PaymentDomainEvent,
  PaymentMethod,
  PaymentStatus,
  Refund,
  RefundStatus,
} from '../../src/payments/entities';
import { PaymentFinalizationService } from '../../src/payments/services/payment-finalization.service';
import { RefundsService } from '../../src/payments/services/refunds.service';
import { Subject } from '../../src/subjects/entities/subject.entity';
import { SubjectStatus } from '../../src/subjects/entities/subject-status.enum';
import { User, UserRole } from '../../src/users/entities';
import { UserStatus } from '../../src/users/entities/user-status.enum';
import { API_PREFIX, createE2EApp, resetDatabase } from './fixtures';

/**
 * DEF-019 — "a course certificate is valid only while the student holds a
 * valid, non-revoked purchase for that course", proven against real
 * PostgreSQL rather than mocks: real row locks, the real refund transaction,
 * the real public verification/download surface, and the real course-version
 * snapshot the purchase was made against.
 */
describe('certificate ↔ course entitlement lifecycle (PostgreSQL)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;
  let certificates: CertificatesService;
  let refunds: RefundsService;
  let finalization: PaymentFinalizationService;
  let packages: PackagesService;
  let progress: ProgressService;
  let suffix = 0;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
    certificates = app.get(CertificatesService);
    refunds = app.get(RefundsService);
    finalization = app.get(PaymentFinalizationService);
    packages = app.get(PackagesService);
    progress = app.get(ProgressService);
  });

  beforeEach(async () => {
    await resetDatabase(dataSource);
    suffix = 0;
  });
  afterAll(async () => app.close());

  /* ===================== fixtures ===================== */

  async function makeUser(role: UserRole): Promise<User> {
    suffix += 1;
    const id = String(suffix).padStart(4, '0');
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({
        username: `cert-${role}-${id}`,
        name: `Cert ${role} ${id}`,
        first_name: null,
        last_name: null,
        email: `cert-${role}-${id}@example.test`,
        phone: `01${id.padStart(9, '0')}`,
        role,
        status: UserStatus.APPROVED,
        is_active: true,
        password_hash: null,
      }),
    );
  }

  async function makeSubject(): Promise<Subject> {
    const subjects = dataSource.getRepository(Subject);
    return subjects.save(
      subjects.create({
        name: 'Certificate refund subject',
        name_ar: null,
        description: null,
        description_ar: null,
        thumbnail: null,
        status: SubjectStatus.APPROVED,
        created_by_teacher_id: null,
        rejection_reason: null,
        reviewed_by_admin_id: null,
        reviewed_at: null,
      }),
    );
  }

  async function makeLesson(teacherId: string, subjectId: string, title: string): Promise<Lesson> {
    const lessons = dataSource.getRepository(Lesson);
    return lessons.save(
      lessons.create({
        title,
        description: null,
        teacher_id: teacherId,
        subject_id: subjectId,
        thumbnail: null,
        price: 0,
        duration: 600,
        is_group: true,
        available_for_days: 365,
        students_count: 0,
        is_free_preview: false,
      }),
    );
  }

  /** A published course with `lessonCount` lessons, ready to sell. */
  async function makeCourse(
    teacherId: string,
    subjectId: string,
    lessonCount: number,
  ): Promise<{ course: { id: string }; lessons: Lesson[] }> {
    const course = await packages.create(teacherId, {
      title: 'Refundable Course',
      subject_id: subjectId,
      price: 300,
      status: CourseStatus.PUBLISHED,
    } as never);
    const lessons: Lesson[] = [];
    for (let index = 0; index < lessonCount; index++) {
      lessons.push(await makeLesson(teacherId, subjectId, `Lesson ${String(index + 1)}`));
    }
    await packages.addLessons(course.id, teacherId, {
      lessons: lessons.map((lesson, index) => ({ lessonId: lesson.id, orderIndex: index })),
    } as never);
    return { course, lessons };
  }

  async function publishedTemplate(): Promise<CertificateTemplate> {
    const templates = dataSource.getRepository(CertificateTemplate);
    return templates.save(
      templates.create({
        name: 'DEF-019 design',
        title: 'Certificate of Completion',
        title_ar: null,
        body: 'Presented to {{student}} for {{course}}.',
        body_ar: null,
        signature_name: null,
        signature_title: null,
        signature_title_ar: null,
        accent_color: '#6d28d9',
        layout: 'classic',
        font: 'sans',
        title_font_size: 34,
        body_font_size: 16,
        text_alignment: 'center',
        owner_id: null,
        status: CertificateTemplateStatus.PUBLISHED,
        is_default: true,
      }),
    );
  }

  /** Real checkout finalization for a PACKAGE order — writes the version snapshot. */
  async function purchaseCourse(
    studentId: string,
    teacherId: string,
    packageId: string,
    ref: string,
  ): Promise<{ order: Order; payment: Payment }> {
    const finalAmountMinor = 30_000;
    const commissionMinor = 9_000;
    const orders = dataSource.getRepository(Order);
    const payments = dataSource.getRepository(Payment);

    const order = await orders.save(
      orders.create({
        order_number: `E2E-CERT-${ref}`,
        student_id: studentId,
        teacher_id: teacherId,
        item_type: ItemType.PACKAGE,
        item_id: packageId,
        quantity: 1,
        original_amount_minor: finalAmountMinor,
        discount_amount_minor: 0,
        final_amount_minor: finalAmountMinor,
        refunded_amount_minor: 0,
        currency: 'EGP',
        payment_channel: PaymentChannel.GATEWAY,
        payment_method: null,
        status: OrderStatus.AWAITING_PAYMENT,
        discount_code_id: null,
        activation_code_id: null,
        payment_id: null,
        cart_checkout_id: null,
        collection_party: CollectionParty.PLATFORM,
        product_title_snapshot: 'Refundable Course',
        product_title_ar_snapshot: null,
        seller_name_snapshot: null,
        platform_commission_bps: 3000,
        platform_commission_minor: commissionMinor,
        teacher_earning_minor: finalAmountMinor - commissionMinor,
        gateway_fee_bps: 0,
        gateway_fee_minor: 0,
        discount_snapshot: null,
        metadata: {},
        expires_at: new Date(Date.now() + 3_600_000),
        paid_at: null,
        cancelled_at: null,
      }),
    );
    const payment = await payments.save(
      payments.create({
        order_id: order.id,
        user_id: studentId,
        item_type: ItemType.PACKAGE,
        item_id: packageId,
        amount: 300,
        discount_amount: 0,
        final_amount: 300,
        amount_minor: finalAmountMinor,
        currency: 'EGP',
        channel: PaymentChannel.GATEWAY,
        provider: null,
        provider_reference: `e2e-cert-${ref}`,
        status: PaymentStatus.PROCESSING,
        payment_method: PaymentMethod.CARD,
        paymob_order_id: null,
        paymob_transaction_id: null,
        idempotency_key: `e2e-cert-${ref}`,
        failure_reason: null,
        completed_at: null,
      }),
    );
    await finalization.finalizeSuccessfulPayment({
      orderId: order.id,
      paymentId: payment.id,
      sourceReference: `e2e-cert-${ref}`,
      verifiedAmountMinor: finalAmountMinor,
      verifiedCurrency: 'EGP',
    });
    return { order: await orders.findOneOrFail({ where: { id: order.id } }), payment };
  }

  /** Mark every lesson of the course complete for the student (real progress path). */
  async function completeEveryLesson(studentId: string, lessons: Lesson[]): Promise<void> {
    for (const lesson of lessons) {
      await progress.updateProgress(studentId, lesson.id, lesson.duration ?? 600);
    }
  }

  /** Request + complete a refund of `amountMinor` through the real service. */
  async function refundOrder(
    orderId: string,
    amountMinor: number,
    ref: string,
  ): Promise<Refund> {
    const requester = await makeUser(UserRole.ADMIN);
    const completer = await makeUser(UserRole.ADMIN);
    const created = await refunds.request(
      { order_id: orderId, amount_minor: amountMinor, reason_code: 'customer_request' } as never,
      requester.id,
    );
    return refunds.complete(
      created.id,
      { external_method: 'bank_transfer', external_reference: `e2e-refund-${ref}` } as never,
      completer.id,
      true, // provider-verified: this suite exercises the post-provider path
    );
  }

  /** One fully paid-up, fully completed student on a fresh course. */
  async function seedCompletedPurchase(ref: string) {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const { course, lessons } = await makeCourse(teacher.id, subject.id, 2);
    await publishedTemplate();
    const { order, payment } = await purchaseCourse(student.id, teacher.id, course.id, ref);
    await completeEveryLesson(student.id, lessons);
    return { teacher, student, course, lessons, order, payment };
  }

  function certificateRepo() {
    return dataSource.getRepository(Certificate);
  }

  /* ===================== eligibility at issue time ===================== */

  it('issues for an active purchase at 100%, and is idempotent on repeat', async () => {
    const { student, course } = await seedCompletedPurchase('happy');

    const first = await certificates.issueForCourse(student.id, course.id);
    expect(first.status).toBe(CertificateStatus.ISSUED);
    expect(first.completion_percentage).toBe(100);

    const second = await certificates.issueForCourse(student.id, course.id);
    expect(second.id).toBe(first.id);
    expect(await certificateRepo().count({ where: { student_id: student.id } })).toBe(1);
  });

  it('refuses a 100%-complete student who never purchased the course', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const { course, lessons } = await makeCourse(teacher.id, subject.id, 2);
    await publishedTemplate();
    await completeEveryLesson(student.id, lessons);

    await expect(certificates.issueForCourse(student.id, course.id)).rejects.toThrow(
      /valid, non-revoked purchase/,
    );
    // …and not even with an admin force override.
    await expect(
      certificates.issueForCourse(student.id, course.id, { force: true }),
    ).rejects.toThrow(/valid, non-revoked purchase/);
    expect(await certificateRepo().count()).toBe(0);
  });

  it('refuses a student whose purchase row has been revoked', async () => {
    const { student, course, payment } = await seedCompletedPurchase('revoked-pp');
    await dataSource
      .getRepository(PackagePurchase)
      .update({ payment_id: payment.id }, { revoked_at: new Date(), revocation_reason: 'manual' });

    await expect(certificates.issueForCourse(student.id, course.id)).rejects.toThrow(
      /valid, non-revoked purchase/,
    );
    expect(await certificateRepo().count()).toBe(0);
  });

  it('refuses a student whose entitlement has been revoked even if the purchase row lags behind', async () => {
    const { student, course, order } = await seedCompletedPurchase('revoked-ent');
    await dataSource
      .getRepository(Entitlement)
      .update(
        { order_id: order.id },
        { status: EntitlementStatus.REVOKED, revoked_at: new Date(), revocation_reason: 'manual' },
      );

    await expect(certificates.issueForCourse(student.id, course.id)).rejects.toThrow(
      /valid, non-revoked purchase/,
    );
  });

  /* ===================== full refund BEFORE issuance ===================== */

  it('blocks every issuance path once a full refund has completed', async () => {
    // Refund BEFORE any certificate exists: the student buys, refunds, and
    // only then finishes the curriculum (their progress rows outlive access).
    const teacher = await makeUser(UserRole.TEACHER);
    const student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const { course, lessons } = await makeCourse(teacher.id, subject.id, 2);
    await publishedTemplate();
    const { order } = await purchaseCourse(student.id, teacher.id, course.id, 'before');
    await refundOrder(order.id, order.final_amount_minor, 'before');
    await completeEveryLesson(student.id, lessons);
    // Lesson completion fires auto-issuance off the event bus — let it settle.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await certificateRepo().count()).toBe(0);

    // 1. direct/manual issuance
    await expect(certificates.issueForCourse(student.id, course.id)).rejects.toThrow(
      /valid, non-revoked purchase/,
    );
    // 2. admin bulk issuance by explicit student id
    const bulk = await certificates.bulkIssue({ packageId: course.id, studentIds: [student.id] });
    expect(bulk).toMatchObject({ issued: 0, skipped: 0 });
    expect(bulk.failed[0]?.studentId).toBe(student.id);
    // 3. bulk "everyone who completed" no longer sees them at all
    await expect(
      certificates.bulkIssue({ packageId: course.id, allCompleted: true }),
    ).rejects.toThrow(/No matching students/);
    // 4. lesson-completion auto-issuance
    await certificates.autoIssueForCompletedLesson(student.id, lessons[0]!.id);
    // 5. the retry cron, with a failure row queued from before the refund
    await dataSource.getRepository(CertificateAutoIssuanceFailure).save({
      student_id: student.id,
      lesson_id: lessons[0]!.id,
      package_id: course.id,
      attempts: 1,
      last_error: 'transient',
      next_retry_at: new Date(Date.now() - 60_000),
      resolved_at: null,
    } as never);
    await certificates.retryPendingAutoIssuanceFailures();

    expect(await certificateRepo().count()).toBe(0);
    const failure = await dataSource
      .getRepository(CertificateAutoIssuanceFailure)
      .findOneOrFail({ where: { student_id: student.id } });
    expect(failure.resolved_at).not.toBeNull();
    expect(failure.last_error).toMatch(/no longer holds a valid purchase/);
  });

  /* ===================== full refund AFTER issuance ===================== */

  it('revokes an issued certificate when the full refund completes, with a full audit trail', async () => {
    const { student, course, order } = await seedCompletedPurchase('after');
    const issued = await certificates.issueForCourse(student.id, course.id);
    expect(issued.status).toBe(CertificateStatus.ISSUED);
    await certificates.setVisibility(issued.id, student.id, true);

    const refund = await refundOrder(order.id, order.final_amount_minor, 'after');
    expect(refund.status).toBe(RefundStatus.SUCCEEDED);

    const revoked = await certificateRepo().findOneOrFail({ where: { id: issued.id } });
    // The historical row survives, credentials intact — nothing is deleted.
    expect(revoked.certificate_number).toBe(issued.certificate_number);
    expect(revoked.verification_code).toBe(issued.verification_code);
    expect(revoked.issued_at).toBeTruthy();
    expect(revoked.status).toBe(CertificateStatus.REVOKED);
    expect(revoked.is_public).toBe(false);
    expect(revoked.revoked_at).not.toBeNull();
    expect(revoked.revoke_reason).toBe('refund:customer_request');
    expect(revoked.revocation_context).toMatchObject({
      source: 'refund',
      refund_id: refund.id,
      order_id: order.id,
    });

    // The final state is deterministic across all four records.
    const purchase = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student.id, package_id: course.id } });
    expect(purchase.revoked_at).not.toBeNull();
    const entitlement = await dataSource
      .getRepository(Entitlement)
      .findOneOrFail({ where: { order_id: order.id } });
    expect(entitlement.status).toBe(EntitlementStatus.REVOKED);
    expect(
      (await dataSource.getRepository(Order).findOneOrFail({ where: { id: order.id } })).status,
    ).toBe(OrderStatus.REFUNDED);

    // History, domain event and payment audit log all recorded exactly once.
    const history = await dataSource
      .getRepository(CertificateHistory)
      .find({ where: { certificate_id: issued.id } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      certificate_number: issued.certificate_number,
      status: CertificateStatus.REVOKED,
    });
    const events = await dataSource
      .getRepository(PaymentDomainEvent)
      .find({ where: { event_name: 'certificate.revoked' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ certificate_id: issued.id, refund_id: refund.id });
    const audits = await dataSource
      .getRepository(PaymentAuditLog)
      .find({ where: { action: 'certificate_revoked_on_full_refund' } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.resource_id).toBe(issued.id);
  });

  it('reports the revoked certificate as invalid on public verification and refuses the PDF', async () => {
    const { student, course, order } = await seedCompletedPurchase('verify');
    const issued = await certificates.issueForCourse(student.id, course.id);
    const code = issued.verification_code;

    const before = await request(server).get(`${API_PREFIX}/certificates/verify/${code}`).expect(200);
    expect(before.body.valid).toBe(true);
    expect(before.body.certificate.status).toBe('issued');
    expect(before.body.certificate.revoked_at).toBeNull();
    await request(server).get(`${API_PREFIX}/certificates/verify/${code}/pdf`).expect(200);

    await refundOrder(order.id, order.final_amount_minor, 'verify');

    const after = await request(server).get(`${API_PREFIX}/certificates/verify/${code}`).expect(200);
    expect(after.body.valid).toBe(false);
    expect(after.body.certificate.status).toBe('revoked');
    expect(after.body.certificate.revoked_at).not.toBeNull();
    // …and is still distinguishable from an unknown code, which 404s.
    await request(server).get(`${API_PREFIX}/certificates/verify/NOSUCHCODE99`).expect(404);
    // A revoked certificate can never be downloaded as a valid document.
    await request(server).get(`${API_PREFIX}/certificates/verify/${code}/pdf`).expect(404);
    // …nor reappear in the public gallery.
    const gallery = await request(server).get(`${API_PREFIX}/certificates/public`).expect(200);
    expect(gallery.body.data).toHaveLength(0);
  });

  it("stops the student themselves from downloading the revoked certificate as a document", async () => {
    const { student, course, order } = await seedCompletedPurchase('own-download');
    const issued = await certificates.issueForCourse(student.id, course.id);

    await expect(
      certificates.getOwnedDownloadableCertificate(issued.id, student.id),
    ).resolves.toMatchObject({ id: issued.id });

    await refundOrder(order.id, order.final_amount_minor, 'own-download');

    await expect(
      certificates.getOwnedDownloadableCertificate(issued.id, student.id),
    ).rejects.toThrow(/revoked and can no longer be downloaded/);
    // …but it stays visible in their own list, honestly marked as revoked.
    const mine = await certificates.getMyCertificates(student.id, 1, 20);
    expect(mine.data).toHaveLength(1);
    expect(mine.data[0]?.status).toBe(CertificateStatus.REVOKED);
  });

  it('cannot be reissued back to validity while the purchase stays refunded', async () => {
    const { student, course, order } = await seedCompletedPurchase('reissue');
    const issued = await certificates.issueForCourse(student.id, course.id);
    await refundOrder(order.id, order.final_amount_minor, 'reissue');

    await expect(certificates.reissueCertificate(issued.id)).rejects.toThrow(
      /valid, non-revoked purchase/,
    );
    const still = await certificateRepo().findOneOrFail({ where: { id: issued.id } });
    expect(still.status).toBe(CertificateStatus.REVOKED);
  });

  /* ===================== partial refund ===================== */

  it('leaves the certificate valid after a PARTIAL refund that preserves entitlement', async () => {
    const { student, course, order } = await seedCompletedPurchase('partial');
    const issued = await certificates.issueForCourse(student.id, course.id);

    const refund = await refundOrder(order.id, Math.floor(order.final_amount_minor / 2), 'partial');
    expect(refund.metadata?.['entitlement_policy']).toBe('retain_on_partial_refund');

    const after = await certificateRepo().findOneOrFail({ where: { id: issued.id } });
    expect(after.status).toBe(CertificateStatus.ISSUED);
    expect(after.revoked_at).toBeNull();
    const purchase = await dataSource
      .getRepository(PackagePurchase)
      .findOneOrFail({ where: { student_id: student.id, package_id: course.id } });
    expect(purchase.revoked_at).toBeNull();
    expect(
      (await dataSource.getRepository(Order).findOneOrFail({ where: { id: order.id } })).status,
    ).toBe(OrderStatus.PARTIALLY_REFUNDED);
  });

  it('revokes only once when the remainder of a partially refunded order is also refunded', async () => {
    const { student, course, order } = await seedCompletedPurchase('remainder');
    const issued = await certificates.issueForCourse(student.id, course.id);

    const half = Math.floor(order.final_amount_minor / 2);
    await refundOrder(order.id, half, 'remainder-1');
    expect(
      (await certificateRepo().findOneOrFail({ where: { id: issued.id } })).status,
    ).toBe(CertificateStatus.ISSUED);

    const second = await refundOrder(order.id, order.final_amount_minor - half, 'remainder-2');
    const revoked = await certificateRepo().findOneOrFail({ where: { id: issued.id } });
    expect(revoked.status).toBe(CertificateStatus.REVOKED);
    expect(revoked.revocation_context).toMatchObject({ refund_id: second.id });

    // Replaying the completion of an already-succeeded refund is a no-op.
    await refunds.complete(
      second.id,
      { external_method: 'bank_transfer', external_reference: 'replay' } as never,
      (await makeUser(UserRole.ADMIN)).id,
      true,
    );
    expect(
      await dataSource.getRepository(CertificateHistory).count({ where: { certificate_id: issued.id } }),
    ).toBe(1);
    expect(
      await dataSource
        .getRepository(PaymentDomainEvent)
        .count({ where: { event_name: 'certificate.revoked' } }),
    ).toBe(1);
    expect(
      await dataSource
        .getRepository(PaymentAuditLog)
        .count({ where: { action: 'certificate_revoked_on_full_refund' } }),
    ).toBe(1);
  });

  /* ===================== concurrency ===================== */

  it('never ends with a valid certificate attached to a revoked purchase when issuance and a full refund race', async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await resetDatabase(dataSource);
      const { student, course, order } = await seedCompletedPurchase(`race-${String(attempt)}`);

      const [issuance] = await Promise.allSettled([
        certificates.issueForCourse(student.id, course.id),
        refundOrder(order.id, order.final_amount_minor, `race-${String(attempt)}`),
      ]);

      const purchase = await dataSource
        .getRepository(PackagePurchase)
        .findOneOrFail({ where: { student_id: student.id, package_id: course.id } });
      expect(purchase.revoked_at).not.toBeNull();

      const certificate = await certificateRepo().findOne({
        where: { student_id: student.id, package_id: course.id },
      });
      if (issuance.status === 'rejected') {
        // The refund won the row lock: the certificate was never created.
        expect(certificate).toBeNull();
        continue;
      }
      // Issuance won the row lock: the refund then found and revoked it.
      expect(certificate).not.toBeNull();
      expect(certificate?.status).toBe(CertificateStatus.REVOKED);
    }
  }, 60_000);

  /* ===================== course versioning (DEF-002) ===================== */

  it('still judges eligibility and completion against the purchased course version', async () => {
    const teacher = await makeUser(UserRole.TEACHER);
    const v1Student = await makeUser(UserRole.STUDENT);
    const v2Student = await makeUser(UserRole.STUDENT);
    const subject = await makeSubject();
    const { course, lessons } = await makeCourse(teacher.id, subject.id, 2);
    await publishedTemplate();

    // V1 buyer completes the two lessons they bought.
    const v1 = await purchaseCourse(v1Student.id, teacher.id, course.id, 'v1');
    await completeEveryLesson(v1Student.id, lessons);
    const v1Certificate = await certificates.issueForCourse(v1Student.id, course.id);
    expect(v1Certificate.completion_percentage).toBe(100);

    // Teacher adds a third lesson → version 2. The V1 buyer is untouched.
    const extra = await makeLesson(teacher.id, subject.id, 'Lesson 3');
    await packages.addLessons(course.id, teacher.id, {
      lessons: [{ lessonId: extra.id, orderIndex: 2 }],
    } as never);
    expect(await certificates.getCourseProgress(v1Student.id, course.id)).toMatchObject({
      total: 2,
      percentage: 100,
    });

    // A V2 buyer with only the first two lessons done is NOT complete.
    await purchaseCourse(v2Student.id, teacher.id, course.id, 'v2');
    await completeEveryLesson(v2Student.id, lessons);
    expect(await certificates.getCourseProgress(v2Student.id, course.id)).toMatchObject({
      total: 3,
      completed: 2,
    });
    await expect(certificates.issueForCourse(v2Student.id, course.id)).rejects.toThrow(
      /not yet complete/,
    );

    // Refunding the V1 buyer revokes THEIR certificate, on their own version,
    // and leaves the (later-version) course and its other buyers alone.
    await refundOrder(v1.order.id, v1.order.final_amount_minor, 'v1-refund');
    expect(
      (await certificateRepo().findOneOrFail({ where: { id: v1Certificate.id } })).status,
    ).toBe(CertificateStatus.REVOKED);
    await completeEveryLesson(v2Student.id, [extra]);
    const v2Certificate = await certificates.issueForCourse(v2Student.id, course.id);
    expect(v2Certificate.status).toBe(CertificateStatus.ISSUED);
    expect(v2Certificate.completion_percentage).toBe(100);
  }, 30_000);
});
