import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `users.role` and `users.status` from free text to native enums.
 *
 * Same drift as `payments`/`notifications`: `InitialSchema1734986400000`
 * created both as plain `character varying` (`role` has no default; `status`
 * defaults to `'PENDING'`), the `User` entity was since typed with
 * `UserRole`/`UserStatus` enums, and no migration ever performed the
 * conversion. Verified directly against a fully-migrated database — both
 * columns are still `varchar`, not a naming false positive.
 *
 * Unlike the tables fixed so far, `users` is near-certain to hold real rows
 * in any live environment, so this lower-cases before casting (the only
 * known source of an uppercase value is `status`'s own `DEFAULT 'PENDING'`)
 * and fails loudly rather than coercing anything that still doesn't match.
 */
export class FixUsersRoleStatusEnums1820000000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TYPE "users_role_enum" AS ENUM ('admin','call_center','teacher','student')`,
    );
    await q.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE "users_role_enum" USING lower("role")::"users_role_enum"`,
    );

    await q.query(
      `CREATE TYPE "users_status_enum" AS ENUM ('pending','approved','rejected')`,
    );
    await q.query(`ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`);
    await q.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE "users_status_enum" USING lower("status")::"users_status_enum"`,
    );
    await q.query(`ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'approved'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT`);
    await q.query(
      `ALTER TABLE "users" ALTER COLUMN "status" TYPE character varying USING "status"::text`,
    );
    await q.query(`ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'PENDING'`);
    await q.query(`DROP TYPE "users_status_enum"`);

    await q.query(
      `ALTER TABLE "users" ALTER COLUMN "role" TYPE character varying USING "role"::text`,
    );
    await q.query(`DROP TYPE "users_role_enum"`);
  }
}
