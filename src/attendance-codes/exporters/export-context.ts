/**
 * Streaming contract shared by every exporter. The service supplies the total
 * row count and a keyset/offset chunk fetcher; exporters pull one bounded page
 * at a time and write it out, so peak memory stays O(chunk) regardless of how
 * many codes match (supporting exports of hundreds of thousands of rows).
 */

/** Flat, presentation-ready projection of an attendance code. */
export interface ExportableCode {
  code: string;
  status: string;
  type: string;
  item_id: string;
  batch_id: string | null;
  is_active: boolean;
  used_at: Date | null;
  expires_at: Date;
  created_at: Date;
}

export interface ExportContext {
  /** Total rows that will be written (drives progress + memory-free paging). */
  total: number;
  /** Fetch one ordered, bounded page of rows. */
  fetchChunk: (offset: number, limit: number) => Promise<ExportableCode[]>;
  /** Optional base URL so QR/PDF encode a redeem link instead of the raw code. */
  redeemBaseUrl?: string;
  /** Progress callback (0–100), throttled by the caller. */
  onProgress?: (percent: number) => void;
}

/** Rows fetched per page while streaming (throughput vs. memory). */
export const EXPORT_CHUNK = 1_000;
