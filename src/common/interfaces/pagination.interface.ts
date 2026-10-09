/**
 * Standard pagination metadata for list responses
 */
export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  /** Present only when a list endpoint was asked for per-status totals. */
  status_counts?: Record<string, number>;
}

/**
 * Generic paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}
