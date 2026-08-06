/**
 * Jest E2E Test Setup
 * Loads .env.test environment variables before running E2E tests
 */

import { join } from 'node:path';

import { config } from 'dotenv';

import { assertTestDatabaseIsSafe } from '../src/config/environment-isolation.guard';

// Load .env.test file
config({ path: join(__dirname, '..', '.env.test') });

// Refuses to proceed if DATABASE_URL/REDIS_URL resolve to a known production
// host — see assertTestDatabaseIsSafe's own doc comment. A stray production
// value here would mean every E2E run's truncate/reseed cycle runs against
// production data.
assertTestDatabaseIsSafe((key) => process.env[key]);

// E2E test environment loaded
// - NODE_ENV: process.env.NODE_ENV
// - REDIS_URL: Set/Not set based on configuration
// - KASHIER_MID: Set/Not set based on configuration
