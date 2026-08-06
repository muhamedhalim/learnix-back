// Environment validation, run standalone — Phase 5 CI/CD
// (STAGING_ENVIRONMENT_IMPLEMENTATION_PLAN.md §12.2 step 10).
//
// Calls the exact same `validate()` NestJS's ConfigModule calls at boot
// (src/config/env.validation.ts), against whatever is currently in
// `process.env`, so a missing/malformed variable — or a staging config that
// trips the cross-environment isolation guard — fails a CI/deploy step
// instead of a live boot. Never prints a variable's value: `validate()`'s own
// thrown error messages name properties and constraints, not values, and this
// script does not read or echo `process.env` itself.
//
// USAGE:
//   npx ts-node -r tsconfig-paths/register scripts/validate-env.ts
//
// Exit 0 = the current environment would pass NestJS's own boot-time
// validation. Exit 1 = it would not; the thrown message is printed to
// stderr.

// Must precede the env.validation import: class-validator's decorators read
// metadata via Reflect.getMetadata, which only exists once this polyfill has
// run. NestJS's own bootstrap gets this transitively through @nestjs/core;
// this standalone script does not, so it is loaded explicitly here.
import 'reflect-metadata';

import { validate } from '../src/config/env.validation';

try {
  validate({ ...process.env });
  console.log('Environment validation passed.');
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
