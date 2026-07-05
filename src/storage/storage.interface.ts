export type StorageVisibility = 'public' | 'private';

export interface StoredFile {
  /**
   * URL to serve the file. For PUBLIC objects this is the canonical public/CDN
   * URL. For PRIVATE objects it is empty — callers must request a time-limited
   * signed URL via {@link StorageProvider.getSignedUrl} using {@link path}.
   */
  url: string;
  /** Provider-relative object key (used for delete / exists / signing). */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Whether the object is publicly reachable or requires a signed URL. */
  visibility: StorageVisibility;
}

export interface UploadParams {
  buffer: Buffer;
  /** Provider-relative object key, e.g. "thumbnails/uuid.jpg". */
  path: string;
  contentType: string;
  /**
   * Access class. `public` → served via the public base URL; `private` →
   * only retrievable through a short-lived signed URL. Defaults to `public`.
   */
  visibility?: StorageVisibility;
}

/**
 * Storage provider abstraction. Business logic depends ONLY on this interface,
 * never on Cloudflare R2 / Bunny / local specifics — so the backing store can
 * change without touching callers. Non-video assets are backed by Cloudflare R2
 * in production; lesson VIDEOS are out of scope here and remain on Bunny Stream.
 */
export interface StorageProvider {
  readonly name: string;
  upload(params: UploadParams): Promise<StoredFile>;
  delete(path: string): Promise<void>;
  /** Whether an object exists at the given key. */
  exists(path: string): Promise<boolean>;
  /** Canonical public URL for a (public) object. No authorization applied. */
  getPublicUrl(path: string): string;
  /**
   * Time-limited signed URL for retrieving a (typically private) object.
   * The caller is responsible for authorizing the request beforehand.
   */
  getSignedUrl(path: string, expiresInSeconds?: number): Promise<string>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
