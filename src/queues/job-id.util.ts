/**
 * Custom BullMQ job ids.
 *
 * BullMQ 5 rejects a custom `jobId` that contains ':' unless it splits into exactly three parts (a
 * compatibility path for legacy repeatable jobs that its next major release removes), and one that is
 * an integer. Ids like `push:<id>` (two parts) or `push:<id>:retry:<ts>` (four parts) therefore throw
 * "Custom Id cannot contain :" from `queue.add`, so the job is never created.
 *
 * Every dedup id is built here from ':'-free parts joined with '.', which keeps it deterministic for the
 * same inputs and valid under both the current and the stricter future rule.
 */
export function queueJobId(...parts: ReadonlyArray<string | number>): string {
  if (parts.length < 2) {
    throw new Error('queueJobId needs a prefix and at least one identifying part');
  }
  return parts
    .map((part) => {
      const value = String(part);
      if (value === '' || value.includes(':')) {
        throw new Error(
          `Invalid BullMQ job id part "${value}": parts must be non-empty and contain no ':'`,
        );
      }
      return value;
    })
    .join('.');
}
