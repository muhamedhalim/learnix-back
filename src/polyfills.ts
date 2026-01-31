/**
 * Polyfills for Node.js runtime compatibility
 * This file MUST be imported before any other imports to ensure globals are available
 */

import * as nodeCrypto from 'crypto';

// Make crypto available globally for packages that expect it (e.g., @nestjs/typeorm)
// This is needed for Node.js 18 and some serverless environments
if (typeof globalThis.crypto === 'undefined') {
  Object.defineProperty(globalThis, 'crypto', {
    value: nodeCrypto.webcrypto,
    writable: false,
    configurable: false,
  });
}

// Ensure crypto.randomUUID is available (Node 18 compatibility)
// Check after setting crypto to avoid TypeScript narrowing issues
const crypto = globalThis.crypto as unknown as typeof nodeCrypto;
if (typeof crypto.randomUUID === 'undefined') {
  crypto.randomUUID = nodeCrypto.randomUUID.bind(nodeCrypto);
}
