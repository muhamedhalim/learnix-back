import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { retryTransaction } from '../../common/utils/transaction-retry.util';
import { DiscountCodesService } from '../../discount-codes/discount-codes.service';
import { biBody } from '../../i18n/error-translator.util';
import { LessonSessionBookingStatus } from '../../lessons/entities/lesson-session-booking-status.enum';
import { LessonSessionsService } from '../../lessons/lesson-sessions.service';
import { Notification } from '../../notifications/entities/notification.entity';
import { NotificationOrigin } from '../../notifications/entities/notification-origin.enum';
import { NotificationStatus } from '../../notifications/entities/notification-status.enum';
import { NotificationType } from '../../notifications/entities/notification-type.enum';
import { StorageService } from '../../storage/storage.service';
import { User } from '../../users/entities/user.entity';
import { UserRole } from '../../users/entities/user-role.enum';
import {
  CreateManualPaymentMethodDto,
  ManualSubmissionFilterDto,
  RejectManualPaymentDto,
  ReviewManualPaymentDto,
  SubmitManualPaymentDto,
  UpdateManualPaymentMethodDto,
} from '../dto';
import {
  CollectionParty,
  ManualPaymentMethod,
  ManualPaymentSubmission,
  ManualPaymentSubmissionStatus,
  Order,
  OrderStatus,
  Payment,
  PaymentAuditLog,
  PaymentChannel,
  PaymentDomainEvent,
  PaymentStatus,
} from '../entities';
import { normalizeManualPaymentConfiguration } from '../manual-payment-method-configuration';
import { PaymentFinalizationService } from './payment-finalization.service';

interface ReceiptFile {
  buffer: Buffer;
  size: number;
  mimetype: string;
}

@Injectable()
export class ManualPaymentsService {
  constructor(
    @InjectRepository(ManualPaymentMethod)
    private readonly methods: Repository<ManualPaymentMethod>,
    @InjectRepository(ManualPaymentSubmission)
    private readonly submissions: Repository<ManualPaymentSubmission>,
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly finalizer: PaymentFinalizationService,
    @Inject(forwardRef(() => DiscountCodesService))
    private readonly discounts: DiscountCodesService,
    private readonly lessonSessions: LessonSessionsService,
  ) {}

  public async createMethod(
    dto: CreateManualPaymentMethodDto,
    adminId: string,
  ): Promise<ManualPaymentMethod> {
    this.assertMethodLimits(dto.minimum_amount_minor, dto.maximum_amount_minor);
    const configuration = this.validateConfiguration(dto.type, dto.configuration);
    return retryTransaction(this.dataSource, async (manager) => {
      const method = manager.create(ManualPaymentMethod, {
        name: dto.name.trim(),
        type: dto.type,
        recipient_name: dto.recipient_name.trim(),
        configuration,
        instructions: dto.instructions.trim(),
        internal_notes: dto.internal_notes?.trim() || null,
        enabled: dto.enabled ?? true,
        display_order: dto.display_order ?? 0,
        minimum_amount_minor: dto.minimum_amount_minor ?? null,
        maximum_amount_minor: dto.maximum_amount_minor ?? null,
        order_expiration_minutes: dto.order_expiration_minutes ?? 1440,
        proof_required: dto.proof_required ?? true,
        transaction_reference_required: dto.transaction_reference_required ?? true,
        countries: dto.countries ?? null,
        collection_party: dto.collection_party ?? CollectionParty.PLATFORM,
        name_ar: null,
        instructions_ar: null,
        destination_details: {},
        legacy_content_metadata: null,
        qr_file_key: null,
        created_by: adminId,
        updated_by: adminId,
      });
      const saved = await manager.save(ManualPaymentMethod, method);
      await this.audit(
        manager,
        adminId,
        'manual_payment_method_created',
        'manual_payment_method',
        saved.id,
        { name: saved.name, type: saved.type },
      );
      return saved;
    });
  }

  public async updateMethod(
    id: string,
    dto: UpdateManualPaymentMethodDto,
    adminId: string,
  ): Promise<ManualPaymentMethod> {
    return retryTransaction(this.dataSource, async (manager) => {
      const method = await manager.findOne(ManualPaymentMethod, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!method) {
        throw new NotFoundException(
          biBody('Manual payment method not found', 'طريقة الدفع اليدوي غير موجودة'),
        );
      }
      const minimum = dto.minimum_amount_minor ?? method.minimum_amount_minor;
      const maximum = dto.maximum_amount_minor ?? method.maximum_amount_minor;
      this.assertMethodLimits(minimum, maximum);
      const type = dto.type ?? method.type;
      const configuration = this.validateConfiguration(
        type,
        dto.configuration ?? method.configuration,
      );
      Object.assign(method, dto, {
        ...dto,
        name: dto.name?.trim() ?? method.name,
        recipient_name: dto.recipient_name?.trim() ?? method.recipient_name,
        instructions: dto.instructions?.trim() ?? method.instructions,
        internal_notes:
          dto.internal_notes === undefined
            ? method.internal_notes
            : dto.internal_notes?.trim() || null,
        configuration,
        updated_by: adminId,
      });
      const saved = await manager.save(ManualPaymentMethod, method);
      await this.audit(
        manager,
        adminId,
        'manual_payment_method_updated',
        'manual_payment_method',
        saved.id,
        { fields: Object.keys(dto) },
      );
      return saved;
    });
  }

  public async listMethods(includeDisabled: boolean): Promise<ManualPaymentMethod[]> {
    const query = this.methods.createQueryBuilder('method');
    if (!includeDisabled) query.where('method.enabled = true');
    return query.orderBy('method.display_order', 'ASC').addOrderBy('method.name', 'ASC').getMany();
  }

  public async submit(
    dto: SubmitManualPaymentDto,
    studentId: string,
    file?: ReceiptFile,
  ): Promise<ManualPaymentSubmission> {
    const order = await this.orders.findOne({
      where: { id: dto.order_id, student_id: studentId },
    });
    const method = await this.methods.findOne({
      // Disabling a method stops new orders, but active issued orders can still
      // submit proof against their snapshotted method.
      where: { id: dto.manual_payment_method_id },
    });
    if (
      !order ||
      order.payment_channel !== PaymentChannel.MANUAL ||
      !method ||
      order.payment_method !== method.id
    ) {
      throw new NotFoundException(
        biBody('Manual payment order or method not found', 'طلب أو طريقة الدفع اليدوي غير موجودة'),
      );
    }
    if (![OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_SUBMITTED].includes(order.status)) {
      throw new ConflictException(
        biBody('Order is not accepting payment proof', 'الطلب لا يقبل إثبات دفع حالياً'),
      );
    }
    if (order.expires_at && order.expires_at <= new Date()) {
      throw new ConflictException(biBody('Order has expired', 'انتهت صلاحية الطلب'));
    }
    if (
      dto.claimed_amount_minor !== order.final_amount_minor ||
      dto.currency.toUpperCase() !== order.currency.toUpperCase()
    ) {
      throw new BadRequestException(
        biBody(
          'Claimed amount or currency does not match the order',
          'المبلغ أو العملة لا يطابقان الطلب',
        ),
      );
    }
    if (method.transaction_reference_required && !dto.transaction_reference?.trim()) {
      throw new BadRequestException(
        biBody('Transaction reference is required', 'مرجع التحويل مطلوب'),
      );
    }
    if (method.proof_required && !file) {
      throw new BadRequestException(biBody('Payment proof is required', 'إثبات الدفع مطلوب'));
    }

    let proof: { key: string; hash: string; mime: string } | undefined;
    if (file) proof = await this.storeProof(file, studentId);
    try {
      return await retryTransaction(this.dataSource, async (manager) => {
        const lockedOrder = await manager.findOne(Order, {
          where: { id: order.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !lockedOrder ||
          ![OrderStatus.AWAITING_PAYMENT, OrderStatus.PAYMENT_SUBMITTED].includes(
            lockedOrder.status,
          )
        ) {
          throw new ConflictException(
            biBody('Order is no longer accepting proof', 'الطلب لم يعد يقبل إثبات الدفع'),
          );
        }
        const revisionCount = await manager.count(ManualPaymentSubmission, {
          where: { order_id: order.id },
        });
        const normalizedReference = dto.transaction_reference?.trim().toUpperCase() ?? null;
        const referenceDuplicates = normalizedReference
          ? await manager.count(ManualPaymentSubmission, {
              where: {
                manual_payment_method_id: method.id,
                transaction_reference: normalizedReference,
              },
            })
          : 0;
        const fileDuplicates = proof
          ? await manager.count(ManualPaymentSubmission, {
              where: { proof_sha256: proof.hash },
            })
          : 0;
        const submission = await manager.save(
          ManualPaymentSubmission,
          manager.create(ManualPaymentSubmission, {
            order_id: order.id,
            student_id: studentId,
            manual_payment_method_id: method.id,
            claimed_amount_minor: dto.claimed_amount_minor,
            currency: dto.currency.toUpperCase(),
            payer_name: dto.payer_name.trim(),
            payer_account_hint: dto.payer_account_hint?.trim() ?? null,
            transaction_reference: normalizedReference,
            paid_at_claimed: dto.paid_at_claimed ? new Date(dto.paid_at_claimed) : null,
            proof_file_key: proof?.key ?? null,
            proof_sha256: proof?.hash ?? null,
            proof_mime_type: proof?.mime ?? null,
            student_note: dto.student_note?.trim() ?? null,
            status: ManualPaymentSubmissionStatus.SUBMITTED,
            submitted_at: new Date(),
            reviewed_by: null,
            reviewed_at: null,
            rejection_reason_code: null,
            rejection_reason: null,
            reviewer_note: null,
            revision_count: revisionCount,
            metadata: {
              risk_flags: [
                ...(referenceDuplicates > 0 ? ['duplicate_reference'] : []),
                ...(fileDuplicates > 0 ? ['duplicate_receipt'] : []),
              ],
              reference_duplicate_count: referenceDuplicates,
              receipt_duplicate_count: fileDuplicates,
            },
          }),
        );
        lockedOrder.status = OrderStatus.PAYMENT_SUBMITTED;
        await manager.save(Order, lockedOrder);
        await this.lessonSessions.markForOrder(
          manager,
          lockedOrder.id,
          LessonSessionBookingStatus.PAYMENT_REVIEW,
        );
        await manager.insert(PaymentAuditLog, {
          actor_id: studentId,
          action: 'manual_payment_submitted',
          resource_type: 'manual_payment_submission',
          resource_id: submission.id,
          details: {
            order_id: order.id,
            order_number: order.order_number,
            risk_flags: (submission.metadata?.['risk_flags'] as string[] | undefined) ?? [],
          } as never,
          ip_address: null,
        });
        await this.insertEvent(
          manager,
          'manual_payment.submitted',
          `manual-submission:${submission.id}:submitted`,
          {
            submission_id: submission.id,
            order_id: order.id,
            student_id: studentId,
            risk_flags: submission.metadata?.['risk_flags'],
          },
        );
        await this.notify(
          manager,
          studentId,
          `manual-submission:${submission.id}:student-received`,
          'Payment proof received',
          `Proof for order ${order.order_number} was received for review.`,
          { submission_id: submission.id, order_id: order.id },
        );
        const admins = await manager.find(User, {
          where: { role: UserRole.ADMIN, is_active: true },
        });
        for (const admin of admins) {
          await this.notify(
            manager,
            admin.id,
            `manual-submission:${submission.id}:admin:${admin.id}`,
            referenceDuplicates > 0 || fileDuplicates > 0
              ? 'Manual payment requires risk review'
              : 'New manual payment proof',
            `Order ${order.order_number} has a new proof submission.`,
            {
              submission_id: submission.id,
              order_id: order.id,
              risk_flags: submission.metadata?.['risk_flags'],
            },
          );
        }
        return submission;
      });
    } catch (error) {
      if (proof) await this.storage.tryDelete(proof.key);
      throw error;
    }
  }

  public async startReview(
    submissionId: string,
    adminId: string,
  ): Promise<ManualPaymentSubmission> {
    return this.transitionReview(
      submissionId,
      adminId,
      [ManualPaymentSubmissionStatus.SUBMITTED],
      ManualPaymentSubmissionStatus.UNDER_REVIEW,
      'manual_payment_review_started',
    );
  }

  public async approve(
    submissionId: string,
    dto: ReviewManualPaymentDto,
    adminId: string,
  ): Promise<ManualPaymentSubmission> {
    return retryTransaction(this.dataSource, async (manager) => {
      const submission = await manager.findOne(ManualPaymentSubmission, {
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !submission ||
        ![
          ManualPaymentSubmissionStatus.SUBMITTED,
          ManualPaymentSubmissionStatus.UNDER_REVIEW,
        ].includes(submission.status)
      ) {
        throw new ConflictException(
          biBody('Submission cannot be approved', 'لا يمكن اعتماد هذا الإثبات'),
        );
      }
      const order = await manager.findOne(Order, {
        where: { id: submission.order_id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new NotFoundException(biBody('Order not found', 'الطلب غير موجود'));
      if (
        ![
          OrderStatus.AWAITING_PAYMENT,
          OrderStatus.PAYMENT_SUBMITTED,
          OrderStatus.UNDER_REVIEW,
          OrderStatus.EXPIRED,
        ].includes(order.status)
      ) {
        throw new ConflictException(
          biBody(
            'Order is not eligible for manual payment approval',
            'الطلب غير مؤهل لاعتماد الدفع اليدوي',
          ),
        );
      }
      if (order.expires_at && order.expires_at <= new Date() && !dto.override_reason?.trim()) {
        throw new BadRequestException(
          biBody(
            'Expired order approval requires an override reason',
            'اعتماد طلب منتهي يتطلب سبب تجاوز',
          ),
        );
      }
      if (
        submission.claimed_amount_minor !== order.final_amount_minor ||
        submission.currency.toUpperCase() !== order.currency.toUpperCase()
      ) {
        throw new BadRequestException(
          biBody(
            'Submission amount or currency does not match the order',
            'مبلغ أو عملة الإثبات لا يطابقان الطلب',
          ),
        );
      }
      if (submission.transaction_reference) {
        const duplicate = await manager
          .getRepository(ManualPaymentSubmission)
          .createQueryBuilder('submission')
          .where('submission.id != :submissionId', { submissionId })
          .andWhere('submission.manual_payment_method_id = :methodId', {
            methodId: submission.manual_payment_method_id,
          })
          .andWhere('submission.transaction_reference = :reference', {
            reference: submission.transaction_reference,
          })
          .andWhere('submission.status = :approved', {
            approved: ManualPaymentSubmissionStatus.APPROVED,
          })
          .getExists();
        if (duplicate) {
          throw new ConflictException(
            biBody('Transaction reference was already approved', 'تم اعتماد مرجع التحويل من قبل'),
          );
        }
      }
      submission.status = ManualPaymentSubmissionStatus.UNDER_REVIEW;
      submission.reviewed_by = adminId;
      submission.reviewer_note = dto.reviewer_note?.trim() ?? null;
      await manager.save(ManualPaymentSubmission, submission);
      order.status = OrderStatus.UNDER_REVIEW;
      await manager.save(Order, order);
      await this.finalizer.finalizeSuccessfulPayment(
        {
          orderId: order.id,
          ...(order.payment_id ? { paymentId: order.payment_id } : {}),
          sourceReference: submission.transaction_reference ?? `manual-submission-${submission.id}`,
          actorId: adminId,
          manualSubmissionId: submission.id,
          verifiedAmountMinor: submission.claimed_amount_minor,
          verifiedCurrency: submission.currency,
        },
        manager,
      );
      if (dto.override_reason?.trim()) {
        await manager.insert(PaymentAuditLog, {
          actor_id: adminId,
          action: 'manual_payment_expiry_override',
          resource_type: 'manual_payment_submission',
          resource_id: submission.id,
          details: { reason: dto.override_reason.trim(), order_id: order.id },
          ip_address: null,
        });
      }
      return submission;
    });
  }

  public async reject(
    submissionId: string,
    dto: RejectManualPaymentDto,
    adminId: string,
  ): Promise<ManualPaymentSubmission> {
    return retryTransaction(this.dataSource, async (manager) => {
      const submission = await this.lockReviewable(manager, submissionId);
      submission.status = ManualPaymentSubmissionStatus.REJECTED;
      submission.reviewed_by = adminId;
      submission.reviewed_at = new Date();
      submission.rejection_reason_code = dto.reason_code;
      submission.rejection_reason = dto.reason?.trim() ?? null;
      submission.reviewer_note = dto.reviewer_note?.trim() ?? null;
      await manager.save(ManualPaymentSubmission, submission);
      const order = await manager.findOne(Order, { where: { id: submission.order_id } });
      if (order && order.status !== OrderStatus.PAID) {
        order.status = OrderStatus.REJECTED;
        await manager.save(Order, order);
        await this.closeUnpaidPayment(manager, order, dto.reason_code);
        await this.lessonSessions.markForOrder(
          manager,
          order.id,
          LessonSessionBookingStatus.FAILED,
        );
      }
      await this.reviewAudit(manager, adminId, 'manual_payment_rejected', submission, {
        reason_code: dto.reason_code,
        reason: dto.reason ?? null,
      });
      await this.insertEvent(
        manager,
        'manual_payment.rejected',
        `manual-submission:${submission.id}:rejected`,
        {
          submission_id: submission.id,
          order_id: submission.order_id,
          reason_code: dto.reason_code,
        },
      );
      await this.notify(
        manager,
        submission.student_id,
        `manual-submission:${submission.id}:student-rejected`,
        'Payment proof rejected',
        dto.reason?.trim() || dto.reason_code,
        { submission_id: submission.id, order_id: submission.order_id },
      );
      return submission;
    });
  }

  public async cancel(
    submissionId: string,
    dto: RejectManualPaymentDto,
    adminId: string,
  ): Promise<ManualPaymentSubmission> {
    return retryTransaction(this.dataSource, async (manager) => {
      const submission = await manager.findOne(ManualPaymentSubmission, {
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !submission ||
        ![
          ManualPaymentSubmissionStatus.SUBMITTED,
          ManualPaymentSubmissionStatus.UNDER_REVIEW,
          ManualPaymentSubmissionStatus.MORE_INFORMATION_REQUIRED,
        ].includes(submission.status)
      ) {
        throw new ConflictException(
          biBody(
            'Submission cannot be cancelled in its current state',
            'لا يمكن إلغاء إثبات الدفع في حالته الحالية',
          ),
        );
      }
      submission.status = ManualPaymentSubmissionStatus.CANCELLED;
      submission.reviewed_by = adminId;
      submission.reviewed_at = new Date();
      submission.rejection_reason_code = dto.reason_code;
      submission.rejection_reason = dto.reason?.trim() ?? null;
      submission.reviewer_note = dto.reviewer_note?.trim() ?? null;
      await manager.save(ManualPaymentSubmission, submission);

      const order = await manager.findOne(Order, { where: { id: submission.order_id } });
      if (order && order.status !== OrderStatus.PAID) {
        order.status = OrderStatus.CANCELLED;
        await manager.save(Order, order);
        await this.closeUnpaidPayment(manager, order, dto.reason_code);
        await this.lessonSessions.markForOrder(
          manager,
          order.id,
          LessonSessionBookingStatus.CANCELLED,
        );
      }
      await this.reviewAudit(manager, adminId, 'manual_payment_cancelled', submission, {
        reason_code: dto.reason_code,
        reason: dto.reason ?? null,
      });
      await this.insertEvent(
        manager,
        'manual_payment.cancelled',
        `manual-submission:${submission.id}:cancelled`,
        {
          submission_id: submission.id,
          order_id: submission.order_id,
          reason_code: dto.reason_code,
        },
      );
      await this.notify(
        manager,
        submission.student_id,
        `manual-submission:${submission.id}:student-cancelled`,
        'Payment submission cancelled',
        dto.reason?.trim() || dto.reason_code,
        { submission_id: submission.id, order_id: submission.order_id },
      );
      return submission;
    });
  }

  public async requestMoreInformation(
    submissionId: string,
    dto: RejectManualPaymentDto,
    adminId: string,
  ): Promise<ManualPaymentSubmission> {
    return retryTransaction(this.dataSource, async (manager) => {
      const submission = await this.lockReviewable(manager, submissionId);
      submission.status = ManualPaymentSubmissionStatus.MORE_INFORMATION_REQUIRED;
      submission.reviewed_by = adminId;
      submission.reviewed_at = new Date();
      submission.rejection_reason_code = dto.reason_code;
      submission.rejection_reason = dto.reason?.trim() ?? null;
      submission.reviewer_note = dto.reviewer_note?.trim() ?? null;
      await manager.save(ManualPaymentSubmission, submission);
      const order = await manager.findOne(Order, { where: { id: submission.order_id } });
      if (order && order.status !== OrderStatus.PAID) {
        order.status = OrderStatus.PAYMENT_SUBMITTED;
        await manager.save(Order, order);
      }
      await this.reviewAudit(
        manager,
        adminId,
        'manual_payment_more_information_required',
        submission,
        {
          reason_code: dto.reason_code,
          reason: dto.reason ?? null,
        },
      );
      await this.insertEvent(
        manager,
        'manual_payment.more_information_required',
        `manual-submission:${submission.id}:more-info`,
        {
          submission_id: submission.id,
          order_id: submission.order_id,
          reason_code: dto.reason_code,
        },
      );
      await this.notify(
        manager,
        submission.student_id,
        `manual-submission:${submission.id}:student-more-information`,
        'More payment information required',
        dto.reason?.trim() || dto.reason_code,
        { submission_id: submission.id, order_id: submission.order_id },
      );
      return submission;
    });
  }

  public async listReviewQueue(
    filter: ManualSubmissionFilterDto,
  ): Promise<{ data: ManualPaymentSubmission[]; meta: PaginationMeta }> {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const query = this.submissions
      .createQueryBuilder('submission')
      .leftJoinAndMapOne('submission.order', Order, 'order', 'order.id = submission.order_id')
      .leftJoinAndMapOne(
        'submission.method',
        ManualPaymentMethod,
        'method',
        'method.id = submission.manual_payment_method_id',
      );
    if (filter.status) query.where('submission.status = :status', { status: filter.status });
    if (filter.method_id)
      query.andWhere('submission.manual_payment_method_id = :methodId', {
        methodId: filter.method_id,
      });
    const [data, total] = await query
      .orderBy('submission.submitted_at', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    const totalPages = Math.ceil(total / limit);
    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  public async listForStudent(studentId: string): Promise<ManualPaymentSubmission[]> {
    return this.submissions.find({
      where: { student_id: studentId },
      order: { submitted_at: 'DESC' },
      take: 100,
    });
  }

  public async getProofUrl(submissionId: string): Promise<{ url: string; expires_in: number }> {
    const submission = await this.submissions.findOne({ where: { id: submissionId } });
    if (!submission?.proof_file_key) {
      throw new NotFoundException(biBody('Payment proof not found', 'إثبات الدفع غير موجود'));
    }
    const expiresIn = 300;
    return {
      url: await this.storage.getSignedUrl(submission.proof_file_key, expiresIn),
      expires_in: expiresIn,
    };
  }

  private async storeProof(
    file: ReceiptFile,
    studentId: string,
  ): Promise<{ key: string; hash: string; mime: string }> {
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
      throw new BadRequestException(
        biBody('Receipt must be 5 MB or smaller', 'يجب ألا يتجاوز الإيصال 5 ميجابايت'),
      );
    }
    const detected = this.detectMime(file.buffer);
    if (!detected) {
      throw new BadRequestException(
        biBody('Unsupported or unsafe receipt file', 'ملف الإيصال غير مدعوم أو غير آمن'),
      );
    }
    const key = `manual-payments/${studentId}/${randomUUID()}.${detected.extension}`;
    await this.storage.upload({
      buffer: file.buffer,
      path: key,
      contentType: detected.mime,
      visibility: 'private',
    });
    return {
      key,
      mime: detected.mime,
      hash: createHash('sha256').update(file.buffer).digest('hex'),
    };
  }

  private detectMime(buffer: Buffer): { mime: string; extension: string } | null {
    if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
      return { mime: 'application/pdf', extension: 'pdf' };
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { mime: 'image/jpeg', extension: 'jpg' };
    }
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.subarray(0, 8).equals(png)) {
      return { mime: 'image/png', extension: 'png' };
    }
    if (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
      return { mime: 'image/webp', extension: 'webp' };
    }
    return null;
  }

  private async lockReviewable(
    manager: EntityManager,
    submissionId: string,
  ): Promise<ManualPaymentSubmission> {
    const submission = await manager.findOne(ManualPaymentSubmission, {
      where: { id: submissionId },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !submission ||
      ![
        ManualPaymentSubmissionStatus.SUBMITTED,
        ManualPaymentSubmissionStatus.UNDER_REVIEW,
      ].includes(submission.status)
    ) {
      throw new ConflictException(
        biBody('Submission is not reviewable', 'إثبات الدفع غير متاح للمراجعة'),
      );
    }
    return submission;
  }

  private async transitionReview(
    submissionId: string,
    adminId: string,
    from: ManualPaymentSubmissionStatus[],
    to: ManualPaymentSubmissionStatus,
    action: string,
  ): Promise<ManualPaymentSubmission> {
    return retryTransaction(this.dataSource, async (manager) => {
      const submission = await manager.findOne(ManualPaymentSubmission, {
        where: { id: submissionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!submission || !from.includes(submission.status)) {
        throw new ConflictException(
          biBody('Submission state has already changed', 'تم تغيير حالة الإثبات بالفعل'),
        );
      }
      submission.status = to;
      submission.reviewed_by = adminId;
      submission.reviewed_at = new Date();
      await manager.save(ManualPaymentSubmission, submission);
      const order = await manager.findOne(Order, { where: { id: submission.order_id } });
      if (order && order.status !== OrderStatus.PAID) {
        order.status = OrderStatus.UNDER_REVIEW;
        await manager.save(Order, order);
      }
      await this.reviewAudit(manager, adminId, action, submission, null);
      return submission;
    });
  }

  private async reviewAudit(
    manager: EntityManager,
    adminId: string,
    action: string,
    submission: ManualPaymentSubmission,
    details: Record<string, unknown> | null,
  ): Promise<void> {
    await manager.insert(PaymentAuditLog, {
      actor_id: adminId,
      action,
      resource_type: 'manual_payment_submission',
      resource_id: submission.id,
      details: { order_id: submission.order_id, ...(details ?? {}) },
      ip_address: null,
    });
  }

  private async audit(
    manager: EntityManager,
    actorId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await manager.insert(PaymentAuditLog, {
      actor_id: actorId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      details: details as never,
      ip_address: null,
    });
  }

  private async insertEvent(
    manager: EntityManager,
    eventName: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(PaymentDomainEvent)
      .values({
        event_name: eventName,
        dedupe_key: dedupeKey,
        payload: payload as never,
        published_at: null,
        attempts: 0,
        last_error: null,
      })
      .orIgnore()
      .execute();
  }

  private async closeUnpaidPayment(
    manager: EntityManager,
    order: Order,
    reasonCode: string,
  ): Promise<void> {
    if (!order.payment_id) return;
    await manager.update(
      Payment,
      { id: order.payment_id },
      {
        status: PaymentStatus.FAILED,
        failure_reason: `manual_review:${reasonCode}`,
      },
    );
    await this.discounts.releaseUsageForPayment(order.payment_id, manager);
  }

  private async notify(
    manager: EntityManager,
    userId: string,
    dedupeKey: string,
    title: string,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(Notification)
      .values({
        dedupe_key: dedupeKey,
        origin: NotificationOrigin.SYSTEM,
        source_event: 'manual_payment_notification',
        user_id: userId,
        type: NotificationType.PURCHASE,
        title,
        message,
        data,
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

  private validateConfiguration(
    type: ManualPaymentMethod['type'],
    configuration: Record<string, unknown>,
  ): Record<string, string> {
    try {
      return normalizeManualPaymentConfiguration(type, configuration);
    } catch (error) {
      throw new BadRequestException(
        biBody(
          error instanceof Error ? error.message : 'Manual payment configuration is invalid',
          'إعدادات طريقة الدفع اليدوية غير صالحة',
        ),
      );
    }
  }

  private assertMethodLimits(minimum?: number | null, maximum?: number | null): void {
    if (
      minimum !== null &&
      minimum !== undefined &&
      maximum !== null &&
      maximum !== undefined &&
      minimum > maximum
    ) {
      throw new BadRequestException(
        biBody(
          'Minimum amount cannot exceed maximum amount',
          'لا يمكن أن يتجاوز الحد الأدنى الحد الأقصى',
        ),
      );
    }
  }
}
