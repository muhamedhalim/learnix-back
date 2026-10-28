import { Injectable } from '@nestjs/common';

import { StorageService } from '../../storage/storage.service';
import type { StoredFile } from '../../storage/storage.interface';
import { signedUrlExpired } from './errors';

/** FR-303 — the platform's existing signed-URL lifetime; never exceeded. */
const MAX_SIGNED_URL_TTL_SECONDS = 900;

export interface UploadPrivateAssetParams {
  buffer: Buffer;
  path: string;
  contentType: string;
}

/** Public marketing images (course covers, instructor photos) live only here — see `MarketplaceImageService`. */
const PUBLIC_IMAGE_FOLDER_PREFIX = 'images/marketplace/';

/**
 * The only way marketplace code touches object storage (FR-051, FR-303).
 * Every upload is forced private — there is no public-upload path here, so
 * paid content can never be given a durable public URL by mistake. Every
 * signed-URL issuance re-runs the caller's authorisation check first; a
 * cached "was authorised a minute ago" is never trusted.
 */
@Injectable()
export class MarketplaceStorageService {
  constructor(private readonly storage: StorageService) {}

  public async uploadPrivate(params: UploadPrivateAssetParams): Promise<StoredFile> {
    return this.storage.upload({ ...params, visibility: 'private' });
  }

  /**
   * The single, deliberate exception to "every upload is private": a public image for a course cover
   * or an instructor photo. It refuses any path outside `images/marketplace/`, so it cannot be used to
   * publish a document, a video or anything else, and paid content still can never get a public URL.
   */
  public async uploadPublicImage(params: UploadPrivateAssetParams): Promise<StoredFile> {
    if (!params.path.startsWith(PUBLIC_IMAGE_FOLDER_PREFIX) || params.path.includes('..')) {
      throw new Error(`Public marketplace uploads are limited to ${PUBLIC_IMAGE_FOLDER_PREFIX}`);
    }
    return this.storage.upload({ ...params, visibility: 'public' });
  }

  /** T222 (FR-315) — the retention sweep's only storage access; kept here rather than reaching around this boundary with a raw `StorageService` injection elsewhere. */
  public async delete(path: string): Promise<void> {
    await this.storage.delete(path);
  }

  /**
   * `authorize` is re-evaluated on every call — never memoised by the
   * caller across requests. Returns a URL valid for at most
   * `MAX_SIGNED_URL_TTL_SECONDS`, regardless of what `expiresInSeconds`
   * requests. Callers MUST NOT log the returned URL or place it in a
   * cacheable response (FR-303) — that discipline lives at the call site,
   * this service only bounds the lifetime and re-checks access.
   */
  public async getSignedUrl(
    path: string,
    authorize: () => Promise<boolean> | boolean,
    expiresInSeconds?: number,
  ): Promise<string> {
    const authorized = await authorize();
    if (!authorized) {
      throw signedUrlExpired();
    }
    const ttl = Math.min(expiresInSeconds ?? MAX_SIGNED_URL_TTL_SECONDS, MAX_SIGNED_URL_TTL_SECONDS);
    return this.storage.getSignedUrl(path, ttl);
  }
}
