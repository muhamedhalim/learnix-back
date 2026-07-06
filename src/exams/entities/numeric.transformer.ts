import type { ValueTransformer } from 'typeorm';

/**
 * Transforms Postgres `numeric` columns (returned as strings by the driver) into
 * JS numbers on read, and passes numbers straight through on write. Prevents the
 * "score is a string / NaN" class of bugs the legacy exam module suffered from.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null): number | null => value ?? null,
  from: (value?: string | null): number | null =>
    value === null || value === undefined ? null : Number(value),
};
