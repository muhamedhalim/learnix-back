export interface StoredFile {
  /** Public URL to serve the file (CDN or local serve route). */
  url: string;
  /** Provider-relative path (used for deletion). */
  path: string;
  /** Size in bytes. */
  size: number;
}

export interface UploadParams {
  buffer: Buffer;
  /** Provider-relative path, e.g. "thumbnails/uuid.jpg". */
  path: string;
  contentType: string;
}

/**
 * Storage provider abstraction. Business logic depends ONLY on this interface,
 * never on Bunny/local specifics — so the backing store can change without
 * touching callers.
 */
export interface StorageProvider {
  readonly name: string;
  upload(params: UploadParams): Promise<StoredFile>;
  delete(path: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
