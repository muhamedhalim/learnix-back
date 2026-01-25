/**
 * Jest E2E Test Setup
 * Loads .env.test environment variables before running E2E tests
 */

import { config } from 'dotenv';
import { join } from 'path';

// Load .env.test file
config({ path: join(__dirname, '..', '.env.test') });

// E2E test environment loaded
// - NODE_ENV: process.env.NODE_ENV
// - REDIS_URL: Set/Not set based on configuration
// - KASHIER_MID: Set/Not set based on configuration
