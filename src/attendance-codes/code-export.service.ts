import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Queue } from 'bullmq';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessThan, Repository } from 'typeorm';

import { PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { JOB_TYPES, QUEUE_NAMES } from '../queues/queues.constants';
import { applyCodeSelection, CodeSelection } from './code-query.util';
import { CodeExportFilterDto, CreateCodeExportDto } from './dto';
import {
  AttendanceCode,
  AttendanceCodeAudit,
  AttendanceCodeAuditAction,
  CodeExport,
  CodeExportFormat,
  CodeExportStatus,
  PdfLayout,
} from './entities';
import { ExportableCode, ExportContext, exportCsv, exportExcel, exportJson } from './exporters';
import { exportPdf } from './exporters/pdf.exporter';
import { StorageObjectNotFoundError, type StoredObject } from '../storage/storage.interface';
import { StorageService } from '../storage/storage.service';
import type { Readable } from 'node:stream';

interface FormatMeta {
  ext: string;
  contentType: string;
  job: string;
}

/** Per-format file extension, MIME type and BullMQ job name. */
/** Object-storage prefix for finished exports (private; see StorageService). */
const EXPORT_KEY_PREFIX = 'code-exports/';

const FORMAT_META: Record<CodeExportFormat, FormatMeta> = {
  [CodeExportFormat.CSV]: {
    ext: 'csv',
    contentType: 'text/csv; charset=utf-8',
    job: JOB_TYPES.EXPORT.CSV,
  },
  [CodeExportFormat.EXCEL]: {
    ext: 'xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    job: JOB_TYPES.EXPORT.EXCEL,
  },
  [CodeExportFormat.PDF]: {
    ext: 'pdf',
    contentType: 'application/pdf',
    job: JOB_TYPES.EXPORT.PDF,
  },
  [CodeExportFormat.JSON]: {
    ext: 'json',
    contentType: 'application/json',
    job: JOB_TYPES.EXPORT.JSON,
  },
  [CodeExportFormat.QR]: {
    ext: 'pdf',
    contentType: 'application/pdf',
    job: JOB_TYPES.EXPORT.QR,
  },
};

/**
 * Manages asynchronous attendance-code exports: persists a job, enqueues it,
 * streams matching codes into a cached file (CSV/Excel/PDF/JSON/QR) off the
 * request path, and serves the result for download.
 *
 * The worker builds each file in a local scratch directory, uploads it to PRIVATE object
 * storage (`code-exports/<id>.<ext>`), and deletes the scratch file. Downloads stream from
 * object storage, so any API task can serve a file produced by any worker task. Objects are
 * removed by {@link cleanupExpired} after their TTL.
 */
@Injectable()
export class CodeExportService {
  private readonly logger = new Logger(CodeExportService.name);
  /** Scratch space only: never the system of record (the file lives in object storage). */
  private readonly storageDir =
    process.env['CODE_EXPORT_DIR'] ?? join(tmpdir(), 'learnix-code-exports');
  private readonly ttlMs =
    Number.parseInt(process.env['CODE_EXPORT_TTL_HOURS'] ?? '24', 10) * 3_600_000;
  private readonly redeemBaseUrl = process.env['CODE_REDEEM_BASE_URL'] ?? '';

  constructor(
    @InjectRepository(CodeExport)
    private readonly exportRepo: Repository<CodeExport>,
    @InjectRepository(AttendanceCode)
    private readonly codeRepo: Repository<AttendanceCode>,
    @InjectRepository(AttendanceCodeAudit)
    private readonly auditRepo: Repository<AttendanceCodeAudit>,
    @InjectQueue(QUEUE_NAMES.CODE_EXPORT)
    private readonly exportQueue: Queue,
    private readonly storage: StorageService,
  ) {}

  /* ============================ Job lifecycle ============================ */

  /** Persist a PENDING export and enqueue it; returns immediately for polling. */
  public async createExport(dto: CreateCodeExportDto, adminId: string): Promise<CodeExport> {
    // Opportunistic cleanup keeps the cache bounded without a dedicated cron.
    void this.cleanupExpired().catch((err) =>
      this.logger.warn(`Export cleanup failed: ${(err as Error).message}`),
    );

    const layout = this.resolveLayout(dto.format, dto.layout);
    const filters = (dto.filters ?? {}) as Record<string, unknown>;

    const record = await this.exportRepo.save(
      this.exportRepo.create({
        format: dto.format,
        layout,
        status: CodeExportStatus.PENDING,
        progress: 0,
        filters,
        batch_id: (dto.filters?.batch_id ?? null) as string | null,
        expires_at: new Date(Date.now() + this.ttlMs),
        created_by: adminId,
      }),
    );

    await this.auditRepo.insert({
      batch_id: record.batch_id,
      action: AttendanceCodeAuditAction.EXPORT_REQUESTED,
      actor_id: adminId,
      metadata: {
        export_id: record.id,
        format: dto.format,
        layout: layout ?? undefined,
      },
    });

    await this.exportQueue.add(FORMAT_META[dto.format].job, {
      exportId: record.id,
    });

    this.logger.log(`Queued export ${record.id} (${dto.format}) by ${adminId}`);
    return record;
  }

  /**
   * Build the export file (called by the BullMQ worker). Idempotent: an export
   * already past PENDING is skipped. On success the record is COMPLETED with the
   * cached file's metadata; on failure it is marked FAILED and the error rethrown
   * so BullMQ can apply its retry policy.
   */
  public async runExport(exportId: string, onProgress?: (percent: number) => void): Promise<void> {
    const record = await this.exportRepo.findOne({ where: { id: exportId } });
    if (!record) {
      this.logger.warn(`runExport: export ${exportId} not found`);
      return;
    }
    if (record.status !== CodeExportStatus.PENDING) {
      this.logger.warn(`runExport: export ${exportId} already ${record.status}; skipping`);
      return;
    }

    record.status = CodeExportStatus.PROCESSING;
    record.progress = 0;
    await this.exportRepo.save(record);

    const meta = FORMAT_META[record.format];
    const selection = (record.filters ?? {}) as CodeSelection;
    const filePath = join(this.storageDir, `${record.id}.${meta.ext}`);
    const objectKey = `${EXPORT_KEY_PREFIX}${record.id}.${meta.ext}`;
    const fileName = this.buildFileName(record.format, meta.ext);

    try {
      await mkdir(this.storageDir, { recursive: true });

      const total = await applyCodeSelection(
        this.codeRepo.createQueryBuilder('code'),
        selection,
      ).getCount();

      // Throttle progress writes to whole-percent changes to limit DB churn.
      let lastPercent = -1;
      const ctx: ExportContext = {
        total,
        redeemBaseUrl: this.redeemBaseUrl,
        fetchChunk: (offset, limit) => this.fetchChunk(selection, offset, limit),
        onProgress: (percent) => {
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress?.(percent);
            void this.exportRepo.update(record.id, { progress: percent });
          }
        },
      };

      const written = await this.write(record.format, record.layout, filePath, ctx);

      // An empty export has no file; otherwise move the scratch file into private storage.
      let size = 0;
      let storedKey: string | null = null;
      if (total > 0 && existsSync(filePath)) {
        size = (await stat(filePath)).size;
        await this.storage.upload({
          buffer: await readFile(filePath),
          path: objectKey,
          contentType: meta.contentType,
          visibility: 'private',
        });
        storedKey = objectKey;
      }
      await this.exportRepo.update(record.id, {
        status: CodeExportStatus.COMPLETED,
        progress: 100,
        total_count: written,
        file_name: fileName,
        file_path: storedKey,
        file_size: String(size),
      });

      await this.auditRepo.insert({
        batch_id: record.batch_id,
        action: AttendanceCodeAuditAction.EXPORTED,
        actor_id: record.created_by,
        metadata: { export_id: record.id, format: record.format, total: written },
      });

      this.logger.log(`Export ${record.id} completed: ${String(written)} codes`);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      await this.exportRepo.update(record.id, {
        status: CodeExportStatus.FAILED,
        error_message: message,
      });
      this.logger.error(`Export ${record.id} failed: ${message}`);
      throw err;
    } finally {
      await unlink(filePath).catch(() => undefined);
    }
  }

  /* ============================ Queries / download ============================ */

  public async listExports(
    filter: CodeExportFilterDto,
  ): Promise<{ data: CodeExport[]; meta: PaginationMeta }> {
    const { page = 1, limit = 20 } = filter;
    const qb = this.exportRepo
      .createQueryBuilder('exp')
      .leftJoinAndSelect('exp.creator', 'creator');

    if (filter.status) qb.andWhere('exp.status = :s', { s: filter.status });
    if (filter.format) qb.andWhere('exp.format = :f', { f: filter.format });
    if (filter.batch_id) qb.andWhere('exp.batch_id = :b', { b: filter.batch_id });

    qb.orderBy('exp.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [data, total] = await qb.getManyAndCount();
    const totalPages = Math.ceil(total / limit) || 1;
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

  public async getExport(id: string): Promise<CodeExport> {
    const record = await this.exportRepo.findOne({
      where: { id },
      relations: ['creator'],
    });
    if (!record) throw new NotFoundException(biBody('Export not found', 'التصدير غير موجود'));
    return record;
  }

  /**
   * Resolve a completed export's file for streaming download. Records a
   * DOWNLOADED audit event for the batch timeline.
   */
  public async getDownload(
    id: string,
    actorId: string,
  ): Promise<{ stream: Readable; fileName: string; contentType: string; contentLength?: number }> {
    const record = await this.getExport(id);
    if (record.status !== CodeExportStatus.COMPLETED || !record.file_path) {
      throw new NotFoundException(biBody('Export file is not available', 'ملف التصدير غير متاح'));
    }

    let object: StoredObject;
    try {
      object = await this.storage.getObject(record.file_path);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new NotFoundException(biBody('Export file is not available', 'ملف التصدير غير متاح'));
      }
      throw err;
    }

    await this.auditRepo.insert({
      batch_id: record.batch_id,
      action: AttendanceCodeAuditAction.DOWNLOADED,
      actor_id: actorId,
      metadata: { export_id: record.id },
    });

    return {
      stream: object.stream,
      fileName: record.file_name ?? `export.${FORMAT_META[record.format].ext}`,
      contentType: FORMAT_META[record.format].contentType,
      ...(object.contentLength !== undefined ? { contentLength: object.contentLength } : {}),
    };
  }

  /* ============================ Cleanup ============================ */

  /** Remove expired export records and their cached files. */
  public async cleanupExpired(): Promise<{ removed: number }> {
    const expired = await this.exportRepo.find({
      where: { expires_at: LessThan(new Date()) },
    });
    for (const record of expired) {
      await this.storage.tryDelete(record.file_path);
    }
    if (expired.length > 0) {
      await this.exportRepo.remove(expired);
    }
    return { removed: expired.length };
  }

  /* ============================ Helpers ============================ */

  private async fetchChunk(
    selection: CodeSelection,
    offset: number,
    limit: number,
  ): Promise<ExportableCode[]> {
    const rows = await applyCodeSelection(this.codeRepo.createQueryBuilder('code'), selection)
      // Stable ordering for correct offset paging across chunks.
      .orderBy('code.created_at', 'ASC')
      .addOrderBy('code.id', 'ASC')
      .skip(offset)
      .take(limit)
      .getMany();

    return rows.map((c) => ({
      code: c.code,
      status: c.status,
      type: c.type,
      item_id: c.item_id,
      batch_id: c.batch_id,
      is_active: c.is_active,
      used_at: c.used_at,
      expires_at: c.expires_at,
      created_at: c.created_at,
    }));
  }

  private write(
    format: CodeExportFormat,
    layout: PdfLayout | null,
    filePath: string,
    ctx: ExportContext,
  ): Promise<number> {
    switch (format) {
      case CodeExportFormat.CSV:
        return exportCsv(filePath, ctx);
      case CodeExportFormat.JSON:
        return exportJson(filePath, ctx);
      case CodeExportFormat.EXCEL:
        return exportExcel(filePath, ctx);
      case CodeExportFormat.PDF:
      case CodeExportFormat.QR:
        return exportPdf(filePath, layout ?? PdfLayout.A4_GRID, ctx);
    }
  }

  /** PDF/QR default to a sensible layout; data formats never have one. */
  private resolveLayout(format: CodeExportFormat, layout?: PdfLayout): PdfLayout | null {
    if (format === CodeExportFormat.QR) return layout ?? PdfLayout.QR_SHEET;
    if (format === CodeExportFormat.PDF) return layout ?? PdfLayout.A4_GRID;
    return null;
  }

  private buildFileName(format: CodeExportFormat, ext: string): string {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `attendance-codes-${format}-${stamp}.${ext}`;
  }
}
