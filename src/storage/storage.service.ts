import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

import { StorageProvider, StoredFile, UploadParams } from './storage.interface';

const DEFAULT_SIGNED_EXPIRES = 900; // 15 minutes

/**
 * Cloudflare R2 (S3-compatible) provider. Primary backend for every non-video
 * asset. Public objects are served via R2_PUBLIC_BASE_URL; private objects
 * (paid PDFs, verification docs, certificates) are only retrievable through a
 * short-lived pre-signed URL, so they cannot be downloaded by guessing the key.
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
      this.logger.error(`R2 upload failed for ${path}: ${(err as Error).message}`);
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
      this.logger.warn(`R2 delete failed for ${path}: ${(err as Error).message}`);
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

  public getPublicUrl(path: string): string {
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
    private readonly uploadDir: string,
    private readonly backendUrl: string,
  ) {}

  public async upload({ buffer, path, visibility = 'public' }: UploadParams): Promise<StoredFile> {
    const full = join(this.uploadDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return { url: this.getPublicUrl(path), path, size: buffer.length, visibility };
  }

  public async delete(path: string): Promise<void> {
    try {
      await unlink(join(this.uploadDir, path));
    } catch {
      // already gone — ignore
    }
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await stat(join(this.uploadDir, path));
      return true;
    } catch {
      return false;
    }
  }

  public getPublicUrl(path: string): string {
    return `${this.backendUrl.replace(/\/+$/, '')}/api/v1/uploads/${path}`;
  }

  public getSignedUrl(path: string): Promise<string> {
    // No signing locally — return the public serve URL (dev only).
    return Promise.resolve(this.getPublicUrl(path));
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

    if (accountId && accessKeyId && secretAccessKey && bucket && publicBaseUrl) {
      return new R2StorageProvider(
        accountId,
        accessKeyId,
        secretAccessKey,
        bucket,
        this.config.get<string>('R2_REGION') ?? 'auto',
        publicBaseUrl,
        Number.parseInt(this.config.get<string>('SIGNED_URL_EXPIRES_SECONDS') ?? '', 10) ||
          DEFAULT_SIGNED_EXPIRES,
        this.logger,
      );
    }

    const zone = this.config.get<string>('BUNNY_STORAGE_ZONE');
    const password = this.config.get<string>('BUNNY_STORAGE_PASSWORD');
    const cdnUrl = this.config.get<string>('BUNNY_CDN_URL');
    if (zone && password && cdnUrl) {
      return new BunnyStorageProvider(
        zone,
        password,
        cdnUrl,
        this.config.get<string>('BUNNY_STORAGE_REGION'),
        this.logger,
      );
    }

    this.logger.warn('No object storage configured (R2/Bunny) — using local disk fallback.');
    return new LocalStorageProvider(
      this.config.get<string>('UPLOAD_DIR') ?? './uploads',
      this.config.get<string>('BACKEND_URL') ?? 'http://localhost:3001',
    );
  }

  public get name(): string {
    return this.provider.name;
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
   */
  public toKey(value: string): string {
    if (value === '') return value;
    let path = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        path = new URL(value).pathname;
      } catch {
        path = value;
      }
    }
    // Strip a legacy local-serve prefix if present.
    path = path.replace(/^\/+/, '').replace(/^api\/v1\/uploads\//, '');
    return path;
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
