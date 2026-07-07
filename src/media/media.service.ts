import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PUBLIC_MEDIA_FOLDERS } from '../common/constants';
import { StorageObjectNotFoundError, StoredObject } from '../storage/storage.interface';
import { StorageService } from '../storage/storage.service';

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

  constructor(
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

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
      throw new NotFoundException('File not found');
    }
    return `${folder}/${filename}`;
  }

  public async fetchObject(key: string): Promise<StoredObject> {
    try {
      return await this.storage.getObject(key);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new NotFoundException('File not found');
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
    const backendUrl = this.config.get<string>('BACKEND_URL') ?? 'http://localhost:3001';
    return `${backendUrl.replace(/\/+$/, '')}/api/v1/media/public/${key}`;
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
    if (!this.storage.isOwnUrl(value)) return value;
    return this.buildPublicUrl(this.storage.toKey(value));
  }
}
