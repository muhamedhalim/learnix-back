import { Transform, Type } from 'class-transformer';
import { IsInt, Max, Min, ValidationOptions } from 'class-validator';

interface StrictIntegerQueryOptions {
  min?: number;
  max?: number;
  integerMessage?: ValidationOptions;
  minMessage?: ValidationOptions;
  maxMessage?: ValidationOptions;
}

/**
 * Strictly parse a base-10 integer query parameter before validating its range.
 *
 * Nest's global implicit conversion turns values such as whitespace into zero,
 * while `parseInt` accepts partially valid input such as `1abc`. Query values
 * are therefore forced to strings first and are converted only when the whole
 * value is an unsigned decimal safe integer. Arrays (repeated parameters),
 * decimals, exponents, whitespace, SQL-like payloads, NaN, Infinity and
 * overflow remain unconverted and fail `IsInt` with a controlled 400 response.
 */
export function StrictIntegerQuery(
  options: StrictIntegerQueryOptions = {},
): PropertyDecorator {
  const min = options.min ?? 1;
  // A finite page ceiling keeps `(page - 1) * limit` within a safe integer
  // while still allowing ordinary deep-page access. Limit fields add their
  // own smaller endpoint-specific `@Max` (normally 100).
  const max = options.max ?? 10_000_000;

  return (target: object, propertyKey: string | symbol): void => {
    Type(() => String)(target, propertyKey);
    Transform(({ value }): unknown => {
      if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
        return value;
      }

      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : value;
    })(target, propertyKey);
    IsInt(options.integerMessage)(target, propertyKey);
    Min(min, options.minMessage)(target, propertyKey);
    Max(max, options.maxMessage)(target, propertyKey);
  };
}
