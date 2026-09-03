import { ExtendCertificatesForMarketplace2100000000000 } from './2100000000000-ExtendCertificatesForMarketplace';

describe('ExtendCertificatesForMarketplace migration', () => {
  it('backfills every existing row to source=academic before the one-subject constraint is added', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ExtendCertificatesForMarketplace2100000000000().up({ query } as never);

    const calls = query.mock.calls.map(([statement]) => String(statement));
    const backfillIndex = calls.findIndex((sql) => sql.includes('SET "source" = \'academic\''));
    const constraintIndex = calls.findIndex((sql) => sql.includes('CHK_certificates_one_subject'));
    expect(backfillIndex).toBeGreaterThanOrEqual(0);
    expect(constraintIndex).toBeGreaterThan(backfillIndex);
  });

  it('makes package_id nullable and adds only additive columns — no existing column is dropped or narrowed', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ExtendCertificatesForMarketplace2100000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('ALTER COLUMN "package_id" DROP NOT NULL');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "marketplace_course_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "source"');
    expect(sql).not.toMatch(/DROP COLUMN/);
    expect(sql).toContain("DEFAULT 'academic'");
  });

  it('the one-subject CHECK constraint requires exactly one of package_id / marketplace_course_id', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ExtendCertificatesForMarketplace2100000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('("package_id" IS NOT NULL AND "marketplace_course_id" IS NULL)');
    expect(sql).toContain('("package_id" IS NULL AND "marketplace_course_id" IS NOT NULL)');
  });

  it('down() restores package_id NOT NULL after removing the additive columns', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new ExtendCertificatesForMarketplace2100000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP COLUMN IF EXISTS "source"');
    expect(sql).toContain('DROP COLUMN IF EXISTS "marketplace_course_id"');
    expect(sql).toContain('ALTER COLUMN "package_id" SET NOT NULL');
  });
});
