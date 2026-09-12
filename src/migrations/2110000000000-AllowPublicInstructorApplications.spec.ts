import { AllowPublicInstructorApplications2110000000000 } from './2110000000000-AllowPublicInstructorApplications';

describe('AllowPublicInstructorApplications migration', () => {
  it('makes users.role nullable without dropping its default', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowPublicInstructorApplications2110000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "role" DROP NOT NULL');
    // Existing inserts that omit the column must keep behaving as before.
    expect(sql).not.toContain('ALTER COLUMN "role" DROP DEFAULT');
  });

  it('lets an application exist before its account, with contact details instead', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowPublicInstructorApplications2110000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ALTER COLUMN "user_id" DROP NOT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "applicant_email" varchar(255) NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "applicant_phone" varchar(30) NULL');
  });

  it('still requires every application to identify its applicant somehow', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowPublicInstructorApplications2110000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CHK_mp_applications_applicant_identity');
    expect(sql).toContain('CHECK ("user_id" IS NOT NULL OR "applicant_email" IS NOT NULL)');
  });

  it('keeps one-open-application-per-applicant for accountless applicants', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowPublicInstructorApplications2110000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "UQ_mp_applications_applicant_email_open"',
    );
    expect(sql).toContain('WHERE "user_id" IS NULL');
  });

  it('down() restores both NOT NULL constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AllowPublicInstructorApplications2110000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP INDEX IF EXISTS "UQ_mp_applications_applicant_email_open"');
    expect(sql).toContain('ALTER COLUMN "user_id" SET NOT NULL');
    expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "role" SET NOT NULL');
    // Rollback must not leave NULL roles behind that the restored constraint rejects.
    expect(sql).toContain(`UPDATE "users" SET "role" = 'student' WHERE "role" IS NULL`);
  });
});
