import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, ValidationOptions } from 'class-validator';

/** Values accepted as `true` / `false`, case-insensitive and trimmed. */
const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0']);

/**
 * Strictly parse a boolean query parameter.
 *
 * ## The bug this replaces
 * Filter DTOs previously wrote:
 *
 * ```ts
 * @Transform(({ value }) => value === 'true' || value === true)
 * @IsBoolean() @IsOptional()
 * public is_group?: boolean;
 * ```
 *
 * which looks correct but is not, because `main.ts` enables
 * `transformOptions: { enableImplicitConversion: true }` on the global
 * `ValidationPipe`. Implicit conversion runs **first** and coerces the raw
 * query string with `Boolean(value)` — and `Boolean('false')` is `true`. By the
 * time the `@Transform` callback saw `value`, the string was already the
 * boolean `true`, so the comparison `value === true` passed:
 *
 * | query        | before | intended |
 * |--------------|--------|----------|
 * | `?f=true`    | true   | true     |
 * | `?f=false`   | **true** ❌ | false |
 * | `?f=0`       | **true** ❌ | false |
 *
 * Every `false` filter therefore returned the opposite of what was asked.
 * `GET /lessons?is_group=false` — the public one-to-one shop surface — served
 * group lessons instead.
 *
 * ## Why this reads `obj[key]`
 * `obj` is the untouched plain payload, so the raw string is read *before*
 * implicit conversion can mangle it. That is the only reliable place to see it.
 *
 * Unparseable input (`?f=maybe`) is deliberately passed through unchanged so
 * `@IsBoolean()` rejects it with a 400 rather than silently guessing — the same
 * philosophy as {@link StrictIntegerQuery}.
 */
export function StrictBooleanQuery(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    Transform(({ obj, key }): unknown => {
      const raw: unknown = (obj as Record<string, unknown>)[key];

      if (raw === undefined || raw === null) return undefined;
      if (typeof raw === 'boolean') return raw;

      if (typeof raw === 'string') {
        const normalized = raw.trim().toLowerCase();
        if (normalized === '') return undefined;
        if (TRUE_VALUES.has(normalized)) return true;
        if (FALSE_VALUES.has(normalized)) return false;
      }

      // Anything else (arrays from repeated params, objects, 'maybe') reaches
      // IsBoolean unchanged and fails validation with a controlled 400.
      return raw;
    })(target, propertyKey);
    IsBoolean(options)(target, propertyKey);
    IsOptional()(target, propertyKey);
  };
}
