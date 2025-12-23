/**
 * Jest E2E Test Setup
 * Loads .env.test environment variables before running E2E tests
 */

import { config } from 'dotenv';
import { join } from 'path';

// Load .env.test file
config({ path: join(__dirname, '..', '.env.test') });

console.log('Loaded .env.test for E2E tests');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('REDIS_URL:', process.env.REDIS_URL ? 'Set' : 'Not set');
console.log('KASHIER_MID:', process.env.KASHIER_MID ? 'Set' : 'Not set');
