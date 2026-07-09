/**
 * Shared parsing for compact duration strings like "7d", "15m", "30s".
 *
 * Consolidates the identical regex/parse logic that previously lived in
 * auth.module, auth.controller and auth.service.
 */

export type DurationUnit = 'd' | 'h' | 's' | 'm';

const MS_BY_UNIT: Record<DurationUnit, number> = {
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

const DURATION_PATTERN = /^(\d+)([dhms])$/;

/** Parse a duration string into its numeric value and unit, or null if invalid. */
export function parseDuration(
  duration: string,
): { value: number; unit: DurationUnit } | null {
  const match = DURATION_PATTERN.exec(duration);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    value: Number.parseInt(match[1], 10),
    unit: match[2] as DurationUnit,
  };
}

/** Convert a duration string to milliseconds, or null if invalid. */
export function durationToMilliseconds(duration: string): number | null {
  const parsed = parseDuration(duration);
  if (parsed === null) {
    return null;
  }
  return parsed.value * MS_BY_UNIT[parsed.unit];
}
