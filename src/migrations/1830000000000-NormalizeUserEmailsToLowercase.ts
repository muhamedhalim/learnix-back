import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalizes every existing `users.email` to `trim().toLowerCase()`.
 *
 * `AuthService.login()`/`register()`, `AdminInitializationService`, and the
 * pre-existing `forgotPassword()` all now query/write email using that exact
 * normalization. Without this, any row created before that consistency was
 * introduced — with mixed-case email — would silently stop being findable
 * by login the moment its owner types their email in the casing they
 * originally registered with but the app now lower-cases before comparing.
 *
 * Purely corrective: an email address's deliverability/identity is
 * case-insensitive by convention, so folding case here changes no meaning,
 * only representation. If any two existing rows collide once normalized
 * (e.g. "User@x.com" and "user@x.com" both present — only possible because
 * the original UNIQUE constraint was case-sensitive), this fails loudly on
 * the UNIQUE constraint rather than silently merging or guessing which row
 * should win.
 */
export class NormalizeUserEmailsToLowercase1830000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "users" SET "email" = lower(trim("email"))`);
  }

  public async down(): Promise<void> {
    // Original casing is not recoverable — this is intentionally a one-way
    // data-hygiene correction, not a reversible schema change.
  }
}
