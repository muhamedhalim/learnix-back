import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PUBLIC_MEDIA_FOLDERS } from '../common/constants';
import {
  buildAbsoluteUrl,
  isNonPublicHostname,
  parsePublicOrigin,
} from '../config/public-url.util';
import { StorageObjectNotFoundError, StoredObject } from '../storage/storage.interface';
import { StorageService } from '../storage/storage.service';
import { biBody } from '../i18n/error-translator.util';

/** One year — thumbnail keys are UUID-named and never overwritten in place. */
const PUBLIC_MEDIA_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Backs the public media proxy endpoint. Never hands the frontend a storage
 * URL (signed or otherwise) — it fetches object bytes from `StorageService`
 * and the controller streams them straight to the client, so R2/Bunny/local
 * details never leak past this module.
 */
@Injectable()
export class MediaService {
  public readonly cacheControl = `public, max-age=${PUBLIC_MEDIA_MAX_AGE_SECONDS.toString()}, immutable`;
  private readonly publicMediaBaseUrl: string;

  constructor(
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {
    this.publicMediaBaseUrl = this.resolvePublicMediaBaseUrl();
  }

  /**
   * Build the backend-relative object key for a folder/filename pair, only
   * if the folder belongs to the public-media allowlist. Throws NotFound
   * (not BadRequest) for disallowed folders — the endpoint must not reveal
   * *why* a private folder's contents are unreachable.
   */
  public resolveKey(folder: string, filename: string): string {
    const allowed: readonly string[] = PUBLIC_MEDIA_FOLDERS;
    if (
      !allowed.includes(folder) ||
      folder.includes('..') ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      throw new NotFoundException(biBody('File not found', 'الملف غير موجود'));
    }
    return `${folder}/${filename}`;
  }

  public async fetchObject(key: string): Promise<StoredObject> {
    try {
      return await this.storage.getObject(key);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new NotFoundException(biBody('File not found', 'الملف غير موجود'));
      }
      throw err;
    }
  }

  /**
   * Public URL for a stored key, routed through this backend's own media
   * proxy rather than the underlying storage provider. Used by other modules
   * (lessons, packages) to turn a stored key/legacy URL into `thumbnail_url`.
   */
  public buildPublicUrl(key: string): string {
    return buildAbsoluteUrl(
      this.publicMediaBaseUrl,
      `/api/v1/media/public/${key.replace(/^\/+/, '')}`,
    );
  }

  /**
   * Resolve a value stored in a `thumbnail`-style column to a `thumbnail_url`
   * the frontend can render directly. Handles three cases:
   *  - a bare storage key (new uploads) → proxied through this endpoint
   *  - a legacy full storage URL (old uploads, incl. the previously-broken
   *    unsigned R2 URL) → normalized back to a key and proxied
   *  - a genuinely external URL (a teacher pasted a foreign image link) →
   *    passed through unchanged, since we don't own that object
   * Returns null if unset.
   */
  public resolveThumbnailUrl(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (!this.storage.isOwnUrl(value)) {
      return this.isSafeExternalPublicUrl(value) ? value : null;
    }
    return this.buildPublicUrl(this.storage.toKey(value));
  }

  /** Store provider-owned media as a key; reject any new localhost URL. */
  public normalizeStoredPublicReference(value: string): string {
    if (!this.storage.isOwnUrl(value) && !this.isSafeExternalPublicUrl(value)) {
      throw new BadRequestException(
        biBody(
          'Only public HTTP(S) URLs can be used for public media',
          'لا يمكن استخدام روابط localhost للوسائط العامة',
        ),
      );
    }
    return this.storage.isOwnUrl(value) ? this.storage.toKey(value) : value;
  }

  private resolvePublicMediaBaseUrl(): string {
    const configured =
      this.config.get<string>('PUBLIC_MEDIA_BASE_URL') ?? this.config.get<string>('BACKEND_URL');
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';
    if (!configured) {
      if (isProduction) {
        throw new Error('PUBLIC_MEDIA_BASE_URL (or BACKEND_URL) is required in production');
      }
      return 'http://localhost:3001';
    }

    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new Error('PUBLIC_MEDIA_BASE_URL must be an absolute URL');
    }
    return parsePublicOrigin(
      url.toString(),
      configured === this.config.get<string>('PUBLIC_MEDIA_BASE_URL')
        ? 'PUBLIC_MEDIA_BASE_URL'
        : 'BACKEND_URL',
      isProduction,
    );
  }

  private isSafeExternalPublicUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      const hostname = url.hostname.toLowerCase();

      // Raw provider endpoints are implementation details, not public-media
      // origins. A configured legacy provider URL is handled by isOwnUrl()
      // above and converted to our media proxy; an unknown provider URL must
      // never pass through a response unchanged.
      if (
        hostname === 'r2.cloudflarestorage.com' ||
        hostname.endsWith('.r2.cloudflarestorage.com') ||
        hostname === 'storage.bunnycdn.com' ||
        hostname.endsWith('.storage.bunnycdn.com')
      ) {
        return false;
      }

      const isProduction = this.config.get<string>('NODE_ENV') === 'production';
      return !isProduction || (url.protocol === 'https:' && !isNonPublicHostname(hostname));
    } catch {
      return false;
    }
  }
}
