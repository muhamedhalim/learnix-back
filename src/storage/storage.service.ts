import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { PUBLIC_MEDIA_FOLDERS } from '../common/constants';
import { parsePublicOrigin } from '../config/public-url.util';
import {
  StorageObjectNotFoundError,
  StorageProvider,
  StoredFile,
  StoredObject,
  UploadParams,
} from './storage.interface';

/** Best-effort extension → MIME map for the local-disk fallback (dev/CI only). */
const LOCAL_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

const DEFAULT_SIGNED_EXPIRES = 900; // 15 minutes
const PRIVATE_LOCAL_PREFIXES = [
  'books/',
  'omr-sheets/',
  'lesson-resources/',
  'homework-submissions/',
  'resources/',
  'attachments/',
] as const;

/**
 * Build a diagnostic, non-sensitive description of an AWS-SDK / R2 error. The
 * SDK's `err.message` alone is often just "Access Denied"; the useful signal
 * lives in `name`, `Code`, `$metadata.httpStatusCode` and `$fault`. We surface
 * those (never credentials) so failures are actionable in the logs instead of a
 * generic wrapper.
 */
function describeS3Error(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    Code?: string;
    $fault?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const status = e?.$metadata?.httpStatusCode;
  const parts = [
    e?.name && `name=${e.name}`,
    e?.Code && e.Code !== e.name && `code=${e.Code}`,
    status && `status=${status}`,
    e?.$fault && `fault=${e.$fault}`,
    e?.message && `message=${e.message}`,
  ].filter(Boolean);
  let hint = '';
  if (status === 403 || e?.name === 'AccessDenied') {
    hint =
      ' — the R2 API token is missing write permission for this bucket. ' +
      'Re-issue an R2 token with "Object Read & Write" scoped to the bucket ' +
      'and update R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.';
  } else if (status === 404 || e?.name === 'NoSuchBucket') {
    hint = ' — the R2 bucket does not exist or R2_BUCKET is misconfigured.';
  }
  return `${parts.join(' ')}${hint}`;
}

/**
 * Cloudflare R2 (S3-compatible) provider. Primary backend for every non-video
 * asset. Browser-facing public assets are served through MediaController and
 * private objects (paid PDFs, submissions, OMR scans) are streamed only after
 * backend authorization. R2_PUBLIC_BASE_URL is retained solely to recognize
 * and migrate legacy persisted URLs; callers must never return provider URLs.
 */
class R2StorageProvider implements StorageProvider {
  public readonly name = 'r2';
  private readonly s3: S3Client;

  constructor(
    accountId: string,
    accessKeyId: string,
    secretAccessKey: string,
    private readonly bucket: string,
    region: string,
    private readonly publicBaseUrl: string,
    private readonly signedExpires: number,
    private readonly logger: Logger,
  ) {
    this.s3 = new S3Client({
      region: region !== '' ? region : 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // R2 requires path-style addressing.
      forcePathStyle: true,
    });
  }

  public async upload({
    buffer,
    path,
    contentType,
    visibility = 'public',
  }: UploadParams): Promise<StoredFile> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: buffer,
          ContentType: contentType,
        }),
      );
    } catch (err) {
      // Log the ORIGINAL exception (with stack + AWS metadata) so the real
      // cause is diagnosable; the caller still gets a friendly message.
      this.logger.error(
        `R2 upload failed for ${path}: ${describeS3Error(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw new Error('File upload failed');
    }
    return {
      url: visibility === 'public' ? this.getPublicUrl(path) : '',
      path,
      size: buffer.length,
      visibility,
    };
  }

  public async delete(path: string): Promise<void> {
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
    } catch (err) {
      this.logger.warn(`R2 delete failed for ${path}: ${describeS3Error(err)}`);
    }
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }));
      return true;
    } catch {
      return false;
    }
  }

  public async getObject(path: string): Promise<StoredObject> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
      if (!res.Body) {
        throw new StorageObjectNotFoundError(path);
      }
      return {
        stream: res.Body as Readable,
        contentType: res.ContentType ?? 'application/octet-stream',
        contentLength: res.ContentLength,
      };
    } catch (err) {
      const code =
        (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        throw new StorageObjectNotFoundError(path);
      }
      if (err instanceof StorageObjectNotFoundError) throw err;
      this.logger.error(`R2 getObject failed for ${path}: ${describeS3Error(err)}`);
      throw err;
    }
  }

  public getPublicUrl(path: string): string {
    if (this.publicBaseUrl === '') return '';
    return `${this.publicBaseUrl.replace(/\/+$/, '')}/${path}`;
  }

  public getSignedUrl(path: string, expiresInSeconds?: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: path }), {
      expiresIn: expiresInSeconds ?? this.signedExpires,
    });
  }
}

/**
 * Bunny.net *Storage* provider (file storage — NOT Bunny Stream video). Retained
 * as a fallback for deployments still configured against it. Objects are public
 * via the CDN pull-zone; it has no native pre-signing, so signed URLs fall back
 * to the public URL.
 */
class BunnyStorageProvider implements StorageProvider {
  public readonly name = 'bunny';
  private readonly base: string;

  constructor(
    private readonly zone: string,
    private readonly password: string,
    private readonly cdnUrl: string,
    region: string | undefined,
    private readonly logger: Logger,
  ) {
    this.base =
      region && region !== ''
        ? `https://${region}.storage.bunnycdn.com`
        : 'https://storage.bunnycdn.com';
  }

  public async upload({
    buffer,
    path,
    contentType,
    visibility = 'public',
  }: UploadParams): Promise<StoredFile> {
    const res = await fetch(`${this.base}/${this.zone}/${path}`, {
      method: 'PUT',
      headers: { AccessKey: this.password, 'Content-Type': contentType },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      this.logger.error(`Bunny upload failed (${res.status}) for ${path}`);
      throw new Error('File upload failed');
    }
    return { url: this.getPublicUrl(path), path, size: buffer.length, visibility };
  }

  public async delete(path: string): Promise<void> {
    const res = await fetch(`${this.base}/${this.zone}/${path}`, {
      method: 'DELETE',
      headers: { AccessKey: this.password },
    });
    if (!res.ok && res.status !== 404) {
      this.logger.warn(`Bunny delete failed (${res.status}) for ${path}`);
    }
  }

  public async exists(path: string): Promise<boolean> {
    const res = await fetch(`${this.base}/${this.zone}/${path}`, {
      method: 'HEAD',
      headers: { AccessKey: this.password },
    });
    return res.ok;
  }

  public async getObject(path: string): Promise<StoredObject> {
    const res = await fetch(`${this.base}/${this.zone}/${path}`, {
      method: 'GET',
      headers: { AccessKey: this.password },
    });
    if (res.status === 404) {
      throw new StorageObjectNotFoundError(path);
    }
    if (!res.ok || !res.body) {
      this.logger.error(`Bunny getObject failed (${res.status}) for ${path}`);
      throw new Error(`Bunny getObject failed (${res.status}) for ${path}`);
    }
    const contentLengthHeader = res.headers.get('content-length');
    return {
      stream: Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      contentLength: contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : undefined,
    };
  }

  public getPublicUrl(path: string): string {
    return `${this.cdnUrl.replace(/\/+$/, '')}/${path}`;
  }

  public getSignedUrl(path: string): Promise<string> {
    return Promise.resolve(this.getPublicUrl(path));
  }
}

/** Local-disk fallback, served via the existing /uploads route. Dev/CI only. */
class LocalStorageProvider implements StorageProvider {
  public readonly name = 'local';

  constructor(
    private readonly publicUploadDir: string,
    private readonly privateUploadDir: string,
    private readonly backendUrl: string,
  ) {}

  public async upload({ buffer, path, visibility = 'public' }: UploadParams): Promise<StoredFile> {
    const full = this.fullPath(path, visibility);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return {
      url: visibility === 'public' ? this.getPublicUrl(path) : '',
      path,
      size: buffer.length,
      visibility,
    };
  }

  public async delete(path: string): Promise<void> {
    try {
      await unlink(this.fullPath(path));
    } catch {
      // already gone — ignore
    }
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await stat(this.fullPath(path));
      return true;
    } catch {
      return false;
    }
  }

  public async getObject(path: string): Promise<StoredObject> {
    const full = this.fullPath(path);
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch {
      throw new StorageObjectNotFoundError(path);
    }
    return {
      stream: createReadStream(full),
      contentType: LOCAL_MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      contentLength: size,
    };
  }

  public getPublicUrl(path: string): string {
    return `${this.backendUrl.replace(/\/+$/, '')}/api/v1/media/public/${path}`;
  }

  public getSignedUrl(path: string): Promise<string> {
    // No signing locally — return the public serve URL (dev only).
    if (this.isPrivatePath(path)) {
      throw new Error(
        'Local private objects are not exposed through signed URLs; use a protected streaming route.',
      );
    }

    return Promise.resolve(this.getPublicUrl(path));
  }

  private fullPath(path: string, visibility?: UploadParams['visibility']): string {
    const root =
      visibility === 'private' || this.isPrivatePath(path)
        ? this.privateUploadDir
        : this.publicUploadDir;
    return join(root, path);
  }

  private isPrivatePath(path: string): boolean {
    return PRIVATE_LOCAL_PREFIXES.some((prefix) => path.startsWith(prefix));
  }
}

/**
 * Centralized storage facade. Every module persists non-video assets through
 * this service — no module talks to Cloudflare / Bunny / disk directly.
 * Provider selection (once, at construction): R2 → Bunny Storage → local disk.
 */
@Injectable()
export class StorageService implements StorageProvider {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider: StorageProvider;

  constructor(private readonly config: ConfigService) {
    this.provider = this.selectProvider();
    this.logger.log(`Storage provider: ${this.provider.name}`);
  }

  private selectProvider(): StorageProvider {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID');
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY');
    const bucket = this.config.get<string>('R2_BUCKET');
    const publicBaseUrl = this.config.get<string>('R2_PUBLIC_BASE_URL');

    if (accountId && accessKeyId && secretAccessKey && bucket) {
      if (publicBaseUrl) this.assertProductionPublicUrl(publicBaseUrl, 'R2_PUBLIC_BASE_URL');
      return new R2StorageProvider(
        accountId,
        accessKeyId,
        secretAccessKey,
        bucket,
        this.config.get<string>('R2_REGION') ?? 'auto',
        publicBaseUrl ?? '',
        Number.parseInt(this.config.get<string>('SIGNED_URL_EXPIRES_SECONDS') ?? '', 10) ||
          DEFAULT_SIGNED_EXPIRES,
        this.logger,
      );
    }

    const zone = this.config.get<string>('BUNNY_STORAGE_ZONE');
    const password = this.config.get<string>('BUNNY_STORAGE_PASSWORD');
    const cdnUrl = this.config.get<string>('BUNNY_CDN_URL');
    if (zone && password && cdnUrl) {
      this.assertProductionPublicUrl(cdnUrl, 'BUNNY_CDN_URL');
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new Error(
          'Bunny public storage cannot protect paid/private objects; configure a private R2 bucket.',
        );
      }
      return new BunnyStorageProvider(
        zone,
        password,
        cdnUrl,
        this.config.get<string>('BUNNY_STORAGE_REGION'),
        this.logger,
      );
    }

    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error('R2 or Bunny object storage must be configured in production');
    }
    this.logger.warn('No object storage configured (R2/Bunny) - using local disk fallback.');
    return new LocalStorageProvider(
      this.config.get<string>('UPLOAD_DIR') ?? './uploads',
      this.config.get<string>('PRIVATE_UPLOAD_DIR') ?? './private-uploads',
      this.config.get<string>('BACKEND_URL') ?? 'http://localhost:3001',
    );
  }

  public get name(): string {
    return this.provider.name;
  }

  private assertProductionPublicUrl(value: string, variableName: string): void {
    if (this.config.get<string>('NODE_ENV') !== 'production') return;
    parsePublicOrigin(
      value,
      variableName as 'R2_PUBLIC_BASE_URL' | 'BUNNY_CDN_URL',
      true,
    );
  }

  public upload(params: UploadParams): Promise<StoredFile> {
    return this.provider.upload(params);
  }

  public delete(path: string): Promise<void> {
    return this.provider.delete(path);
  }

  public exists(path: string): Promise<boolean> {
    return this.provider.exists(path);
  }

  public getObject(path: string): Promise<StoredObject> {
    return this.provider.getObject(path);
  }

  public getPublicUrl(path: string): string {
    return this.provider.getPublicUrl(path);
  }

  public getSignedUrl(path: string, expiresInSeconds?: number): Promise<string> {
    return this.provider.getSignedUrl(path, expiresInSeconds);
  }

  /** Replace an existing object with new bytes at the same key (upload wins). */
  public async replace(params: UploadParams): Promise<StoredFile> {
    return this.upload(params);
  }

  /**
   * Normalize a stored asset reference to its object key. Accepts either a bare
   * key ("books/uuid.pdf") or a full/legacy URL (public base + key, or a legacy
   * `/api/v1/uploads/...` path) and returns the signable/deletable key.
   *
   * Strips this provider's own public-URL prefix FIRST (rather than just
   * `new URL().pathname`) because R2's public base URL includes the bucket
   * name in its path (e.g. `https://<acct>.r2.cloudflarestorage.com/<bucket>`)
   * — naive pathname extraction would leave the bucket name as a bogus leading
   * key segment.
   */
  public toKey(value: string): string {
    if (value === '') return value;
    const publicPrefix = this.getPublicUrl('');
    if (publicPrefix !== '' && value.startsWith(publicPrefix)) {
      return value.slice(publicPrefix.length).replace(/^\/+/, '');
    }
    let path = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        path = new URL(value).pathname;
      } catch {
        path = value;
      }
    }
    // Strip a legacy local-serve prefix if present.
    path = path
      .replace(/^\/+/, '')
      .replace(/^api\/v1\/uploads\//, '')
      .replace(/^api\/v1\/media\/public\//, '')
      .replace(/^uploads\//, '');
    return path;
  }

  /**
   * Whether `value` refers to an object in THIS storage backend (a bare key,
   * this provider's own public URL, or a legacy `/api/v1/uploads/...` path) —
   * as opposed to an arbitrary externally-hosted URL a user pasted in. Used to
   * decide whether a `thumbnail`-style value can be safely rewritten to route
   * through the public media proxy.
   */
  public isOwnUrl(value: string): boolean {
    if (!/^https?:\/\//i.test(value)) return true;
    const publicPrefix = this.getPublicUrl('');
    if (publicPrefix !== '' && value.startsWith(publicPrefix)) return true;
    try {
      const parsed = new URL(value);
      const pathname = parsed.pathname.replace(/^\/+/, '');
      if (pathname.startsWith('api/v1/uploads/') || pathname.startsWith('api/v1/media/public/')) {
        return true;
      }
      const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname.toLowerCase());
      if (!isLocalHost) return false;
      const legacyPath = pathname.replace(/^uploads\//, '');
      return PUBLIC_MEDIA_FOLDERS.some((folder) => legacyPath.startsWith(`${folder}/`));
    } catch {
      return false;
    }
  }

  /** Best-effort delete that never throws (for cleanup paths). */
  public async tryDelete(path: string | null | undefined): Promise<void> {
    if (!path) return;
    try {
      await this.delete(path);
    } catch (err) {
      this.logger.warn(`tryDelete failed for ${path}: ${(err as Error).message}`);
    }
  }
}
