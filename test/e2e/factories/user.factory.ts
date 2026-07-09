import { randomBytes, randomInt } from 'node:crypto';

/** Registration payload matching RegisterDto (name/email/password/phone). */
export interface RegisterPayload {
  name: string;
  email: string;
  password: string;
  phone: string;
  parentPhone?: string;
}

/** A valid Egyptian mobile number: 010/011/012/015 + 8 digits. */
function randomEgyptianPhone(): string {
  const prefixes = ['010', '011', '012', '015'];
  const prefix = prefixes[randomInt(prefixes.length)]!;
  let rest = '';
  for (let i = 0; i < 8; i++) rest += randomInt(10).toString();
  return `${prefix}${rest}`;
}

/**
 * Build a unique, valid registration payload. Each call produces distinct
 * email/phone so suites never collide on the users unique constraints.
 */
export function buildRegisterPayload(
  overrides: Partial<RegisterPayload> = {},
): RegisterPayload {
  const suffix = randomBytes(4).toString('hex');
  return {
    name: `E2E User ${suffix}`,
    email: `e2e_${suffix}@example.com`,
    password: 'Test1234!@#$',
    phone: randomEgyptianPhone(),
    ...overrides,
  };
}
