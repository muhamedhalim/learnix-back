import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  StorageProvider,
  StoredFile,
  UploadParams,
} from './storage.interface';

/**
 * Bunny.net Storage provider. Uploads to a storage zone and serves via the
 * configured CDN pull-zone URL. Never logs the access key.
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

  public async upload({ buffer, path, contentType }: UploadParams): Promise<StoredFile> {
    const res = await fetch(`${this.base}/${this.zone}/${path}`, {
      method: 'PUT',
      headers: { AccessKey: this.password, 'Content-Type': contentType },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      this.logger.error(`Bunny upload failed (${res.status}) for ${path}`);
      throw new Error('File upload failed');
    }
    return {
      url: `${this.cdnUrl.replace(/\/+$/, '')}/${path}`,
      path,
      size: buffer.length,
    };
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
}

/** Local-disk fallback, served via the existing /uploads/:folder/:filename route. */
class LocalStorageProvider implements StorageProvider {
  public readonly name = 'local';

  constructor(
    private readonly uploadDir: string,
    private readonly backendUrl: string,
  ) {}

  public async upload({ buffer, path }: UploadParams): Promise<StoredFile> {
    const full = join(this.uploadDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return {
      url: `${this.backendUrl.replace(/\/+$/, '')}/api/v1/uploads/${path}`,
      path,
      size: buffer.length,
    };
  }

  public async delete(path: string): Promise<void> {
    try {
      await unlink(join(this.uploadDir, path));
    } catch {
      // already gone — ignore
    }
  }
}

@Injectable()
export class StorageService implements StorageProvider {
  private readonly logger = new Logger(StorageService.name);
  private readonly provider: StorageProvider;

  constructor(private readonly config: ConfigService) {
    const zone = this.config.get<string>('BUNNY_STORAGE_ZONE');
    const password = this.config.get<string>('BUNNY_STORAGE_PASSWORD');
    const cdnUrl = this.config.get<string>('BUNNY_CDN_URL');

    if (zone && password && cdnUrl) {
      this.provider = new BunnyStorageProvider(
        zone,
        password,
        cdnUrl,
        this.config.get<string>('BUNNY_STORAGE_REGION'),
        this.logger,
      );
    } else {
      this.logger.warn(
        'Bunny Storage not configured — using local disk storage fallback.',
      );
      this.provider = new LocalStorageProvider(
        this.config.get<string>('UPLOAD_DIR') ?? './uploads',
        this.config.get<string>('BACKEND_URL') ?? 'http://localhost:3001',
      );
    }
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
}
