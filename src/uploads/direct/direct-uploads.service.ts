import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LessThan, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { StorageService } from '../../storage/storage.service';
import { DirectUpload } from './direct-upload.entity';
import {
  DIRECT_UPLOAD_POLICIES,
  DIRECT_UPLOAD_PURPOSES,
  fileNameIsSafe,
  type DirectUploadBucket,
  type DirectUploadPolicy,
  type DirectUploadPurpose,
} from './direct-upload.policy';

const MIB = 1024 * 1024;
const DEFAULT_PART_SIZE = 64 * MIB;
const MAX_PARTS = 10_000;
/** Presigned URLs are short-lived; a resumed upload simply asks for fresh ones. */
const URL_TTL_SECONDS = 3_600;
/** An upload session that is not completed within this time is aborted and cleaned up. */
const SESSION_TTL_MS = 24 * 3_600_000;
const HEAD_BYTES = 32;

/**
 * The upload is not finished YET (parts missing, or the object has not arrived). Unlike a content
 * or size violation this is recoverable, so the session stays open and the client can carry on.
 */
export class UploadNotCompleteError extends BadRequestException {}

export interface InitDirectUploadInput {
  purpose: DirectUploadPurpose;
  filename: string;
  contentType: string;
  size: number;
}

export type InitDirectUploadResult =
  | {
      upload_id: string;
      mode: 'single';
      url: string;
      headers: Record<string, string>;
      expires_in: number;
    }
  | {
      upload_id: string;
      mode: 'multipart';
      part_size: number;
      total_parts: number;
      expires_in: number;
    };

export interface CompletedDirectUpload {
  id: string;
  purpose: DirectUploadPurpose;
  bucket: string;
  key: string;
  name: string;
  contentType: string;
  size: number;
}

interface Backend {
  client: S3Client;
  bucket: string;
}

/**
 * Browser-to-S3 uploads so file bytes never pass through (or are buffered by) the API.
 *
 * Trust model: the client only ever receives presigned URLs for ONE server-chosen key. Nothing the
 * client says about the file is trusted at `complete` time: the server re-reads the object's real
 * size and type from S3, and sniffs its first bytes, before the object is handed to the caller.
 * Objects that fail are deleted.
 */
@Injectable()
export class DirectUploadsService {
  private readonly logger = new Logger(DirectUploadsService.name);

  constructor(
    @InjectRepository(DirectUpload) private readonly repo: Repository<DirectUpload>,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  /* ------------------------------ capabilities ------------------------------ */

  public capabilities(): {
    enabled: boolean;
    purposes: Array<{ purpose: DirectUploadPurpose; enabled: boolean; max_bytes: number }>;
  } {
    const purposes = DIRECT_UPLOAD_PURPOSES.map((purpose) => ({
      purpose,
      enabled: this.backendFor(DIRECT_UPLOAD_POLICIES[purpose]) !== null,
      max_bytes: DIRECT_UPLOAD_POLICIES[purpose].maxBytes,
    }));
    return { enabled: purposes.some((p) => p.enabled), purposes };
  }

  private backendFor(policy: DirectUploadPolicy): Backend | null {
    const files = this.storage.getDirectUploadBackend();
    if (files === null) return null;
    if (policy.bucket === 'files') return files;
    const videoBucket = this.config.get<string>('VIDEO_SOURCE_BUCKET');
    return videoBucket ? { client: files.client, bucket: videoBucket } : null;
  }

  /* --------------------------------- init ---------------------------------- */

  public async init(userId: string, input: InitDirectUploadInput): Promise<InitDirectUploadResult> {
    const policy = DIRECT_UPLOAD_POLICIES[input.purpose];
    const backend = this.backendFor(policy);
    if (backend === null) {
      throw new BadRequestException(
        biBody('Direct uploads are not available', 'الرفع المباشر غير متاح'),
      );
    }
    if (!policy.isAllowedType(input.contentType) || !fileNameIsSafe(input.filename, input.contentType)) {
      throw new BadRequestException(
        biBody('File extension or type is not allowed', 'امتداد الملف أو نوعه غير مسموح'),
      );
    }
    if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > policy.maxBytes) {
      throw new BadRequestException(
        biBody(
          `File too large (max ${Math.round(policy.maxBytes / MIB)} MB)`,
          `حجم الملف كبير جدًا (الحد الأقصى ${Math.round(policy.maxBytes / MIB)} ميجابايت)`,
        ),
      );
    }

    const id = randomUUID();
    const key = policy.keyFor(userId, input.filename, input.contentType, id);
    const multipart = input.size > this.singlePutMax(policy);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    const base = {
      id,
      user_id: userId,
      purpose: policy.purpose,
      bucket: backend.bucket,
      object_key: key,
      original_name: input.filename,
      content_type: input.contentType,
      declared_size: input.size,
      expires_at: expiresAt,
    };

    if (!multipart) {
      await this.repo.insert({ ...base, mode: 'single', multipart_upload_id: null, part_size: null });
      const url = await getSignedUrl(
        backend.client,
        new PutObjectCommand({
          Bucket: backend.bucket,
          Key: key,
          ContentType: input.contentType,
          ContentLength: input.size,
        }),
        {
          expiresIn: URL_TTL_SECONDS,
          signableHeaders: new Set(['content-type', 'content-length']),
        },
      );
      return {
        upload_id: id,
        mode: 'single',
        url,
        headers: { 'Content-Type': input.contentType },
        expires_in: URL_TTL_SECONDS,
      };
    }

    const partSize = this.partSizeFor(input.size);
    const created = await backend.client.send(
      new CreateMultipartUploadCommand({
        Bucket: backend.bucket,
        Key: key,
        ContentType: input.contentType,
      }),
    );
    if (!created.UploadId) throw new Error('S3 did not return a multipart upload id');
    await this.repo.insert({
      ...base,
      mode: 'multipart',
      multipart_upload_id: created.UploadId,
      part_size: partSize,
    });
    return {
      upload_id: id,
      mode: 'multipart',
      part_size: partSize,
      total_parts: Math.ceil(input.size / partSize),
      expires_in: URL_TTL_SECONDS,
    };
  }

  /** Multipart part size (default 64 MiB; DIRECT_UPLOAD_PART_SIZE_MB, minimum 5, mainly for tests). */
  private basePartSize(): number {
    const mb = Number(this.config.get<string>('DIRECT_UPLOAD_PART_SIZE_MB'));
    return Number.isFinite(mb) && mb >= 5 ? Math.floor(mb) * MIB : DEFAULT_PART_SIZE;
  }

  private singlePutMax(policy: DirectUploadPolicy): number {
    const mb = Number(this.config.get<string>('DIRECT_UPLOAD_SINGLE_MAX_MB'));
    return Number.isFinite(mb) && mb > 0 ? Math.min(policy.singlePutMaxBytes, mb * MIB) : policy.singlePutMaxBytes;
  }

  private partSizeFor(size: number): number {
    const base = this.basePartSize();
    if (size / base <= MAX_PARTS) return base;
    return Math.ceil(size / MAX_PARTS / MIB) * MIB;
  }

  /* ------------------------------ multipart ------------------------------- */

  public async partUrls(
    userId: string,
    id: string,
    partNumbers: number[],
  ): Promise<Record<number, string>> {
    const { row, backend } = await this.openSession(userId, id, 'multipart');
    const totalParts = Math.ceil(row.declared_size / (row.part_size ?? DEFAULT_PART_SIZE));
    const urls: Record<number, string> = {};
    for (const n of new Set(partNumbers)) {
      if (!Number.isInteger(n) || n < 1 || n > totalParts) {
        throw new BadRequestException(biBody('Invalid part number', 'رقم الجزء غير صالح'));
      }
      urls[n] = await getSignedUrl(
        backend.client,
        new UploadPartCommand({
          Bucket: row.bucket,
          Key: row.object_key,
          UploadId: row.multipart_upload_id!,
          PartNumber: n,
        }),
        { expiresIn: URL_TTL_SECONDS },
      );
    }
    return urls;
  }

  /** Parts S3 already holds, so an interrupted upload resumes instead of restarting. */
  public async listParts(
    userId: string,
    id: string,
  ): Promise<Array<{ part_number: number; size: number }>> {
    const { row, backend } = await this.openSession(userId, id, 'multipart');
    return (await this.fetchParts(backend, row)).map((p) => ({
      part_number: p.PartNumber,
      size: p.Size,
    }));
  }

  private async fetchParts(
    backend: Backend,
    row: DirectUpload,
  ): Promise<Array<{ PartNumber: number; ETag: string; Size: number }>> {
    const parts: Array<{ PartNumber: number; ETag: string; Size: number }> = [];
    let marker: string | undefined;
    for (;;) {
      const page = await backend.client.send(
        new ListPartsCommand({
          Bucket: row.bucket,
          Key: row.object_key,
          UploadId: row.multipart_upload_id!,
          ...(marker !== undefined ? { PartNumberMarker: marker } : {}),
        }),
      );
      for (const p of page.Parts ?? []) {
        if (p.PartNumber !== undefined && p.ETag !== undefined && p.Size !== undefined) {
          parts.push({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size });
        }
      }
      if (!page.IsTruncated) break;
      marker = page.NextPartNumberMarker;
      if (marker === undefined) break;
    }
    return parts;
  }

  /* ------------------------------- complete -------------------------------- */

  public async complete(userId: string, id: string): Promise<CompletedDirectUpload> {
    const { row, backend, policy } = await this.openSession(userId, id);

    try {
      if (row.mode === 'multipart') await this.completeMultipart(backend, row);
      await this.verifyStoredObject(backend, row, policy);
    } catch (err) {
      // Not finished yet: keep the session so the client can resume.
      if (err instanceof UploadNotCompleteError) throw err;
      const reason = err instanceof BadRequestException ? 'validation' : 'storage_error';
      await this.discard(backend, row, reason);
      throw err;
    }

    await this.repo.update(row.id, { status: 'completed', completed_at: new Date() });
    return {
      id: row.id,
      purpose: policy.purpose,
      bucket: row.bucket,
      key: row.object_key,
      name: row.original_name,
      contentType: row.content_type,
      size: row.declared_size,
    };
  }

  private async completeMultipart(backend: Backend, row: DirectUpload): Promise<void> {
    const parts = await this.fetchParts(backend, row);
    const partSize = row.part_size ?? DEFAULT_PART_SIZE;
    const expectedParts = Math.ceil(row.declared_size / partSize);
    const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
    const total = sorted.reduce((sum, p) => sum + p.Size, 0);
    const contiguous = sorted.every((p, i) => p.PartNumber === i + 1);
    const sizesOk = sorted.every((p, i) => (i < sorted.length - 1 ? p.Size === partSize : true));
    if (sorted.length !== expectedParts || !contiguous || !sizesOk || total !== row.declared_size) {
      throw new UploadNotCompleteError(
        biBody('Upload is incomplete or its size does not match', 'الرفع غير مكتمل أو الحجم غير مطابق'),
      );
    }
    await backend.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: row.bucket,
        Key: row.object_key,
        UploadId: row.multipart_upload_id!,
        MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
      }),
    );
  }

  /** Re-read what S3 actually holds; trust nothing the browser declared. */
  private async verifyStoredObject(
    backend: Backend,
    row: DirectUpload,
    policy: DirectUploadPolicy,
  ): Promise<void> {
    let head;
    try {
      head = await backend.client.send(
        new HeadObjectCommand({ Bucket: row.bucket, Key: row.object_key }),
      );
    } catch {
      throw new UploadNotCompleteError(biBody('Uploaded file was not found', 'الملف المرفوع غير موجود'));
    }
    if (head.ContentLength !== row.declared_size || head.ContentLength > policy.maxBytes) {
      throw new BadRequestException(
        biBody('Uploaded file size does not match', 'حجم الملف المرفوع غير مطابق'),
      );
    }
    if (head.ContentType !== row.content_type) {
      throw new BadRequestException(
        biBody('Uploaded file type does not match', 'نوع الملف المرفوع غير مطابق'),
      );
    }
    const first = await backend.client.send(
      new GetObjectCommand({
        Bucket: row.bucket,
        Key: row.object_key,
        Range: `bytes=0-${HEAD_BYTES - 1}`,
      }),
    );
    const bytes = Buffer.from(await first.Body!.transformToByteArray());
    if (!policy.verifyContent(row.content_type, bytes)) {
      throw new BadRequestException(
        biBody('File content does not match its type', 'محتوى الملف لا يطابق نوعه'),
      );
    }
  }

  /* -------------------------------- abort --------------------------------- */

  public async abort(userId: string, id: string): Promise<void> {
    const { row, backend } = await this.openSession(userId, id);
    await this.discard(backend, row, 'aborted_by_user', 'aborted');
  }

  /** Aborts sessions nobody finished. Run from a single-runner cron. */
  public async expireStale(): Promise<number> {
    const stale = await this.repo.find({
      where: { status: 'initiated', expires_at: LessThan(new Date()) },
      take: 200,
    });
    for (const row of stale) {
      const policy = DIRECT_UPLOAD_POLICIES[row.purpose as DirectUploadPurpose];
      const backend = policy ? this.backendFor(policy) : null;
      if (backend === null) {
        await this.repo.update(row.id, { status: 'aborted', failure_reason: 'expired' });
        continue;
      }
      await this.discard(backend, row, 'expired', 'aborted');
    }
    return stale.length;
  }

  private async discard(
    backend: Backend,
    row: DirectUpload,
    reason: string,
    status: 'failed' | 'aborted' = 'failed',
  ): Promise<void> {
    // Independent attempts: NoSuchUpload (already completed) must not stop the object delete.
    if (row.mode === 'multipart' && row.multipart_upload_id !== null) {
      try {
        await backend.client.send(
          new AbortMultipartUploadCommand({
            Bucket: row.bucket,
            Key: row.object_key,
            UploadId: row.multipart_upload_id,
          }),
        );
      } catch (err) {
        this.logger.debug(`abort ${row.id}: ${(err as Error).message}`);
      }
    }
    try {
      await backend.client.send(new DeleteObjectCommand({ Bucket: row.bucket, Key: row.object_key }));
    } catch (err) {
      this.logger.debug(`delete ${row.id}: ${(err as Error).message}`);
    }
    await this.repo.update(row.id, { status, failure_reason: reason });
  }

  /* ------------------------------- helpers -------------------------------- */

  private async openSession(
    userId: string,
    id: string,
    mode?: 'single' | 'multipart',
  ): Promise<{ row: DirectUpload; backend: Backend; policy: DirectUploadPolicy }> {
    const row = await this.repo.findOne({ where: { id } });
    // 404 (not 403) for someone else's session: do not confirm that the id exists.
    if (row === null || row.user_id !== userId) {
      throw new NotFoundException(biBody('Upload not found', 'الرفع غير موجود'));
    }
    if (row.status !== 'initiated' || row.expires_at.getTime() < Date.now()) {
      throw new BadRequestException(biBody('Upload session is closed', 'جلسة الرفع مغلقة'));
    }
    if (mode !== undefined && row.mode !== mode) {
      throw new BadRequestException(biBody('Wrong upload mode', 'وضع الرفع غير صحيح'));
    }
    const policy = DIRECT_UPLOAD_POLICIES[row.purpose as DirectUploadPurpose];
    const backend = policy ? this.backendFor(policy) : null;
    if (!policy || backend === null) {
      throw new BadRequestException(
        biBody('Direct uploads are not available', 'الرفع المباشر غير متاح'),
      );
    }
    return { row, backend, policy };
  }
}

export type { DirectUploadBucket };
