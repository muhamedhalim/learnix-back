import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Queue } from 'bullmq';
import { In, IsNull, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { applyCodeSelection } from './code-query.util';
import { generateAttendanceCode } from './code-generator.util';
import { generateQrPngBuffer } from './exporters/qr.util';
import {
  BulkCodeAction,
  BulkCodeActionDto,
  CodeBatchFilterDto,
  CreateCodeBatchDto,
  ListCodesQueryDto,
} from './dto';
import {
  AttendanceCode,
  AttendanceCodeAudit,
  AttendanceCodeAuditAction,
  AttendanceCodeStatus,
  AttendanceCodeType,
  CodeBatch,
  CodeBatchStatus,
} from './entities';

/** Rows inserted per DB round-trip during generation (throughput vs. memory). */
const GENERATION_CHUNK = 2_000;

export interface CodeAnalytics {
  generated: number;
  redeemed: number;
  remaining: number;
  expired: number;
  revoked: number;
  redemptionRate: number; // 0–1
}

export interface BatchTimelineEvent {
  action: string;
  at: Date;
  actor: { id: string; name: string } | null;
  metadata: Record<string, unknown> | null;
}

export interface DashboardAnalytics {
  totalBatches: number;
  totalCodes: number;
  activeCodes: number;
  redeemed: number;
  expired: number;
  revoked: number;
  redemptionRate: number; // 0–1
  dailyGeneration: { date: string; count: number }[];
  dailyRedemption: { date: string; count: number }[];
  mostUsedItems: { item_id: string; type: string; count: number }[];
  mostActiveTeachers: { created_by: string; name: string; count: number }[];
}

/**
 * Enterprise batch management for attendance codes: batch creation (queued
 * generation), advanced filtering, bulk lifecycle actions, audit trail and
 * analytics. Single-code verify/redeem stays in AttendanceCodesService.
 */
@Injectable()
export class CodeBatchesService {
  private readonly logger = new Logger(CodeBatchesService.name);

  constructor(
    @InjectRepository(CodeBatch)
    private readonly batchRepo: Repository<CodeBatch>,
    @InjectRepository(AttendanceCode)
    private readonly codeRepo: Repository<AttendanceCode>,
    @InjectRepository(AttendanceCodeAudit)
    private readonly auditRepo: Repository<AttendanceCodeAudit>,
    @InjectRepository(Lesson)
    private readonly lessonsRepo: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepo: Repository<LessonPackage>,
    @InjectQueue(QUEUE_NAMES.CODE_GENERATION)
    private readonly generationQueue: Queue,
  ) {}

  /* ============================ Batch lifecycle ============================ */

  /** Validate the target item, persist a PENDING batch, and enqueue generation. */
  public async createBatch(dto: CreateCodeBatchDto, adminId: string): Promise<CodeBatch> {
    await this.assertItemExists(dto.type, dto.item_id);

    const batch = await this.batchRepo.save(
      this.batchRepo.create({
        name: dto.name.trim(),
        type: dto.type,
        item_id: dto.item_id,
        requested_count: dto.count,
        generated_count: 0,
        status: CodeBatchStatus.PENDING,
        expires_at: new Date(dto.expires_at),
        created_by: adminId,
      }),
    );

    await this.auditRepo.insert({
      batch_id: batch.id,
      action: AttendanceCodeAuditAction.BATCH_CREATED,
      actor_id: adminId,
      metadata: {
        name: batch.name,
        type: batch.type,
        item_id: batch.item_id,
        requested: batch.requested_count,
      },
    });

    await this.generationQueue.add(JOB_TYPES.CODE.GENERATE_BATCH, {
      batchId: batch.id,
    });

    this.logger.log(`Queued batch ${batch.id} (${String(dto.count)} × ${dto.type}) by ${adminId}`);
    return batch;
  }

  /**
   * Generate the batch's codes in chunks (called by the BullMQ worker). Safe to
   * retry: a batch already past PENDING is skipped. Uniqueness collisions are
   * absorbed via ON CONFLICT DO NOTHING and topped up until the target is met.
   */
  public async runGeneration(
    batchId: string,
    onProgress?: (percent: number) => void,
  ): Promise<void> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) {
      this.logger.warn(`runGeneration: batch ${batchId} not found`);
      return;
    }
    if (batch.status !== CodeBatchStatus.PENDING) {
      this.logger.warn(`runGeneration: batch ${batchId} already ${batch.status}; skipping`);
      return;
    }

    batch.status = CodeBatchStatus.PROCESSING;
    await this.batchRepo.save(batch);

    await this.auditRepo.insert({
      batch_id: batch.id,
      action: AttendanceCodeAuditAction.BATCH_STARTED,
      actor_id: batch.created_by,
      metadata: { requested: batch.requested_count },
    });

    try {
      let generated = batch.generated_count;
      // Bound total attempts to avoid an infinite loop under pathological
      // collision rates (extremely unlikely with a 32^8 space).
      let safety = 0;
      const maxLoops = Math.ceil(batch.requested_count / GENERATION_CHUNK) * 4 + 8;

      while (generated < batch.requested_count && safety++ < maxLoops) {
        const size = Math.min(GENERATION_CHUNK, batch.requested_count - generated);
        const rows = Array.from({ length: size }, () => ({
          code: generateAttendanceCode(),
          type: batch.type,
          item_id: batch.item_id,
          batch_id: batch.id,
          expires_at: batch.expires_at,
          created_by: batch.created_by,
          status: AttendanceCodeStatus.UNUSED,
        }));

        const result = await this.codeRepo
          .createQueryBuilder()
          .insert()
          .into(AttendanceCode)
          .values(rows)
          .orIgnore() // ON CONFLICT DO NOTHING (unique code)
          .returning('id')
          .execute();

        const inserted = Array.isArray(result.raw) ? result.raw.length : 0;
        generated += inserted;

        batch.generated_count = generated;
        await this.batchRepo.update(batch.id, { generated_count: generated });
        onProgress?.(Math.round((generated / batch.requested_count) * 100));
      }

      batch.status = CodeBatchStatus.COMPLETED;
      await this.batchRepo.save(batch);

      await this.auditRepo.insert({
        batch_id: batch.id,
        action: AttendanceCodeAuditAction.GENERATED,
        actor_id: batch.created_by,
        metadata: { generated, requested: batch.requested_count },
      });

      this.logger.log(
        `Batch ${batch.id} completed: ${String(generated)}/${String(batch.requested_count)} codes`,
      );
    } catch (err) {
      batch.status = CodeBatchStatus.FAILED;
      batch.error_message = (err as Error).message.slice(0, 500);
      await this.batchRepo.save(batch);
      await this.auditRepo.insert({
        batch_id: batch.id,
        action: AttendanceCodeAuditAction.BATCH_FAILED,
        actor_id: batch.created_by,
        metadata: { error: batch.error_message },
      });
      this.logger.error(`Batch ${batch.id} failed: ${batch.error_message}`);
      throw err;
    }
  }

  /* ============================ Queries ============================ */

  public async getBatches(
    filter: CodeBatchFilterDto,
  ): Promise<{ data: CodeBatch[]; meta: PaginationMeta }> {
    const { page = 1, limit = 20 } = filter;
    const qb = this.batchRepo
      .createQueryBuilder('batch')
      .leftJoinAndSelect('batch.creator', 'creator');

    if (filter.search) {
      qb.andWhere('batch.name ILIKE :s', { s: `%${filter.search}%` });
    }
    if (filter.status) qb.andWhere('batch.status = :st', { st: filter.status });
    if (filter.type) qb.andWhere('batch.type = :ty', { ty: filter.type });
    if (filter.created_by) {
      qb.andWhere('batch.created_by = :cb', { cb: filter.created_by });
    }
    if (filter.from_date) {
      qb.andWhere('batch.created_at >= :fd', { fd: filter.from_date });
    }
    if (filter.to_date) {
      qb.andWhere('batch.created_at <= :td', { td: filter.to_date });
    }

    qb.orderBy('batch.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, meta: this.meta(page, limit, total) };
  }

  /** Batch detail with a lifecycle breakdown of its codes. */
  public async getBatch(id: string): Promise<CodeBatch & { analytics: CodeAnalytics }> {
    const batch = await this.batchRepo.findOne({
      where: { id },
      relations: ['creator'],
    });
    if (!batch) throw new NotFoundException(biBody('Batch not found', 'الدفعة غير موجودة'));
    const analytics = await this.getAnalytics({ batch_id: id });
    return Object.assign(batch, { analytics });
  }

  public async listCodes(
    query: ListCodesQueryDto,
  ): Promise<{ data: AttendanceCode[]; meta: PaginationMeta }> {
    const { page = 1, limit = 20 } = query;
    const qb = this.buildCodeQuery(query).leftJoinAndSelect('code.user', 'redeemer');

    qb.orderBy('code.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, meta: this.meta(page, limit, total) };
  }

  /* ============================ Bulk actions ============================ */

  public async bulkAction(dto: BulkCodeActionDto, adminId: string): Promise<{ affected: number }> {
    const now = new Date();
    let affected = 0;
    let auditAction: AttendanceCodeAuditAction;

    switch (dto.action) {
      case BulkCodeAction.REVOKE: {
        // Only non-redeemed codes can be revoked.
        const res = await this.codeRepo
          .createQueryBuilder()
          .update(AttendanceCode)
          .set({
            status: AttendanceCodeStatus.REVOKED,
            is_active: false,
            revoked_at: now,
            revoked_by: adminId,
            revoke_reason: dto.reason ?? null,
          })
          .where('id IN (:...ids)', { ids: dto.code_ids })
          .andWhere('status != :redeemed', {
            redeemed: AttendanceCodeStatus.REDEEMED,
          })
          .execute();
        affected = res.affected ?? 0;
        auditAction = AttendanceCodeAuditAction.REVOKED;
        break;
      }
      case BulkCodeAction.DISABLE: {
        const res = await this.codeRepo
          .createQueryBuilder()
          .update(AttendanceCode)
          .set({ is_active: false })
          .where('id IN (:...ids)', { ids: dto.code_ids })
          .execute();
        affected = res.affected ?? 0;
        auditAction = AttendanceCodeAuditAction.DISABLED;
        break;
      }
      case BulkCodeAction.ENABLE: {
        // Reactivate codes that are not terminally revoked/redeemed.
        const res = await this.codeRepo
          .createQueryBuilder()
          .update(AttendanceCode)
          .set({ is_active: true })
          .where('id IN (:...ids)', { ids: dto.code_ids })
          .andWhere('status = :unused', {
            unused: AttendanceCodeStatus.UNUSED,
          })
          .execute();
        affected = res.affected ?? 0;
        auditAction = AttendanceCodeAuditAction.ENABLED;
        break;
      }
      case BulkCodeAction.DELETE: {
        const res = await this.codeRepo.delete({ id: In(dto.code_ids) });
        affected = res.affected ?? 0;
        auditAction = AttendanceCodeAuditAction.DELETED;
        break;
      }
    }

    await this.recordBulkAudit(dto.code_ids, auditAction, adminId, {
      reason: dto.reason,
      requested: dto.code_ids.length,
      affected,
    });

    return { affected };
  }

  /* ============================ Analytics ============================ */

  /**
   * Aggregate counts (optionally scoped by batch/type/item). `expired` is
   * derived from expiry so no cron is required to keep it accurate.
   */
  public async getAnalytics(scope?: {
    batch_id?: string | undefined;
    type?: AttendanceCodeType | undefined;
    item_id?: string | undefined;
  }): Promise<CodeAnalytics> {
    const base = () => {
      const qb = this.codeRepo.createQueryBuilder('code');
      if (scope?.batch_id) qb.andWhere('code.batch_id = :b', { b: scope.batch_id });
      if (scope?.type) qb.andWhere('code.type = :t', { t: scope.type });
      if (scope?.item_id) qb.andWhere('code.item_id = :i', { i: scope.item_id });
      return qb;
    };

    const now = new Date();
    const [generated, redeemed, revoked, expired, remaining] = await Promise.all([
      base().getCount(),
      base().andWhere('code.status = :s', { s: AttendanceCodeStatus.REDEEMED }).getCount(),
      base().andWhere('code.status = :s', { s: AttendanceCodeStatus.REVOKED }).getCount(),
      base()
        .andWhere('code.status = :s', { s: AttendanceCodeStatus.UNUSED })
        .andWhere('code.expires_at <= :now', { now })
        .getCount(),
      base()
        .andWhere('code.status = :s', { s: AttendanceCodeStatus.UNUSED })
        .andWhere('code.is_active = true')
        .andWhere('code.expires_at > :now', { now })
        .getCount(),
    ]);

    return {
      generated,
      redeemed,
      remaining,
      expired,
      revoked,
      redemptionRate: generated > 0 ? redeemed / generated : 0,
    };
  }

  /* ============================ Timeline (Phase 6) ============================ */

  /**
   * Chronological activity timeline for a batch: created → started → progress →
   * completed/failed, plus exports, downloads, revokes and deletes — each with
   * actor, timestamp and metadata. Composed from the immutable audit trail.
   */
  public async getTimeline(batchId: string): Promise<BatchTimelineEvent[]> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(biBody('Batch not found', 'الدفعة غير موجودة'));

    const audits = await this.auditRepo
      .createQueryBuilder('audit')
      .leftJoinAndSelect('audit.actor', 'actor')
      .where('audit.batch_id = :id', { id: batchId })
      .orderBy('audit.created_at', 'ASC')
      .getMany();

    const events: BatchTimelineEvent[] = audits.map((a) => ({
      action: a.action,
      at: a.created_at,
      actor: a.actor ? { id: a.actor.id, name: a.actor.name ?? a.actor.username } : null,
      metadata: a.metadata,
    }));

    // Legacy batches created before audit-on-create: synthesize the origin event.
    const hasCreated = events.some((e) => e.action === AttendanceCodeAuditAction.BATCH_CREATED);
    if (!hasCreated) {
      events.unshift({
        action: AttendanceCodeAuditAction.BATCH_CREATED,
        at: batch.created_at,
        actor: null,
        metadata: { requested: batch.requested_count },
      });
    }

    return events;
  }

  /* ============================ Dashboard (Phase 7) ============================ */

  /**
   * System-wide analytics for the admin dashboard. Aggregates are computed in
   * the database (grouped counts) rather than in memory, so it stays cheap even
   * with millions of codes.
   */
  public async getDashboard(days = 30): Promise<DashboardAnalytics> {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const now = new Date();

    const codeCount = (
      build?: (qb: ReturnType<Repository<AttendanceCode>['createQueryBuilder']>) => void,
    ) => {
      const qb = this.codeRepo.createQueryBuilder('code');
      build?.(qb);
      return qb.getCount();
    };

    const [totalBatches, totalCodes, redeemed, revoked, expired, activeCodes] = await Promise.all([
      this.batchRepo.count(),
      codeCount(),
      codeCount((qb) => qb.where('code.status = :s', { s: AttendanceCodeStatus.REDEEMED })),
      codeCount((qb) => qb.where('code.status = :s', { s: AttendanceCodeStatus.REVOKED })),
      codeCount((qb) =>
        qb
          .where('code.status = :s', { s: AttendanceCodeStatus.UNUSED })
          .andWhere('code.expires_at <= :now', { now }),
      ),
      codeCount((qb) =>
        qb
          .where('code.status = :s', { s: AttendanceCodeStatus.UNUSED })
          .andWhere('code.is_active = true')
          .andWhere('code.expires_at > :now', { now }),
      ),
    ]);

    const [dailyGeneration, dailyRedemption, mostUsedItems, mostActiveTeachers] = await Promise.all(
      [
        this.dailySeries('created_at', since),
        this.dailySeries('used_at', since, AttendanceCodeStatus.REDEEMED),
        this.topItems(),
        this.topTeachers(),
      ],
    );

    return {
      totalBatches,
      totalCodes,
      activeCodes,
      redeemed,
      expired,
      revoked,
      redemptionRate: totalCodes > 0 ? redeemed / totalCodes : 0,
      dailyGeneration,
      dailyRedemption,
      mostUsedItems,
      mostActiveTeachers,
    };
  }

  /** Grouped daily counts over a date column (optionally scoped to a status). */
  private async dailySeries(
    column: 'created_at' | 'used_at',
    since: Date,
    status?: AttendanceCodeStatus,
  ): Promise<{ date: string; count: number }[]> {
    const qb = this.codeRepo
      .createQueryBuilder('code')
      .select(`DATE(code.${column})`, 'date')
      .addSelect('COUNT(*)', 'count')
      .where(`code.${column} >= :since`, { since })
      .andWhere(`code.${column} IS NOT NULL`)
      .groupBy('date')
      .orderBy('date', 'ASC');
    if (status) qb.andWhere('code.status = :s', { s: status });

    const rows = await qb.getRawMany<{ date: string; count: string }>();
    return rows.map((r) => ({
      date: r.date,
      count: Number.parseInt(r.count, 10),
    }));
  }

  private async topItems(): Promise<{ item_id: string; type: string; count: number }[]> {
    const rows = await this.codeRepo
      .createQueryBuilder('code')
      .select('code.item_id', 'item_id')
      .addSelect('code.type', 'type')
      .addSelect('COUNT(*)', 'count')
      .where('code.status = :s', { s: AttendanceCodeStatus.REDEEMED })
      .groupBy('code.item_id')
      .addGroupBy('code.type')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany<{ item_id: string; type: string; count: string }>();
    return rows.map((r) => ({
      item_id: r.item_id,
      type: r.type,
      count: Number.parseInt(r.count, 10),
    }));
  }

  private async topTeachers(): Promise<{ created_by: string; name: string; count: number }[]> {
    const rows = await this.batchRepo
      .createQueryBuilder('batch')
      .leftJoin('batch.creator', 'creator')
      .select('batch.created_by', 'created_by')
      .addSelect('creator.name', 'name')
      .addSelect('COALESCE(SUM(batch.generated_count), 0)', 'count')
      .groupBy('batch.created_by')
      .addGroupBy('creator.name')
      .orderBy('count', 'DESC')
      .limit(10)
      .getRawMany<{ created_by: string; name: string | null; count: string }>();
    return rows.map((r) => ({
      created_by: r.created_by,
      name: r.name ?? 'Unknown',
      count: Number.parseInt(r.count, 10),
    }));
  }

  /** PNG QR image for a single code (admin preview / single-print). */
  public async getCodeQrPng(codeId: string): Promise<Buffer> {
    const code = await this.codeRepo.findOne({ where: { id: codeId } });
    if (!code) throw new NotFoundException(biBody('Code not found', 'الرمز غير موجود'));
    const base = process.env['CODE_REDEEM_BASE_URL'] ?? '';
    return generateQrPngBuffer(code.code, base);
  }

  /* ============================ Helpers ============================ */

  /** Shared code query with all admin filters applied (no pagination). */
  private buildCodeQuery(query: ListCodesQueryDto) {
    return applyCodeSelection(this.codeRepo.createQueryBuilder('code'), query);
  }

  private async assertItemExists(type: AttendanceCodeType, itemId: string): Promise<void> {
    if (type === AttendanceCodeType.LESSON) {
      const found = await this.lessonsRepo.findOne({
        where: { id: itemId, deleted_at: IsNull() },
      });
      if (!found) throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    } else if (type === AttendanceCodeType.PACKAGE) {
      const found = await this.packagesRepo.findOne({
        where: { id: itemId, deleted_at: IsNull() },
      });
      if (!found) throw new NotFoundException(biBody('Package not found', 'الباقة غير موجودة'));
    }
    // BOOK items are validated by the books module elsewhere; parity with the
    // existing single-code generation which does not re-validate books here.
  }

  /** Write one audit row per affected code (chunked), for a complete trail. */
  private async recordBulkAudit(
    codeIds: string[],
    action: AttendanceCodeAuditAction,
    actorId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const CHUNK = 2_000;
    for (let i = 0; i < codeIds.length; i += CHUNK) {
      const slice = codeIds.slice(i, i + CHUNK);
      await this.auditRepo.save(
        this.auditRepo.create(
          slice.map((code_id) => ({
            code_id,
            action,
            actor_id: actorId,
            metadata,
          })),
        ),
      );
    }
  }

  private meta(page: number, limit: number, total: number): PaginationMeta {
    const totalPages = Math.ceil(total / limit) || 1;
    return {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };
  }
}
