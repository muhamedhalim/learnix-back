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
