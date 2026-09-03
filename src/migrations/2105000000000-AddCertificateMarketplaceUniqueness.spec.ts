import { AddCertificateMarketplaceUniqueness2105000000000 } from './2105000000000-AddCertificateMarketplaceUniqueness';

describe('AddCertificateMarketplaceUniqueness migration', () => {
  it('creates a partial unique index scoped to rows with a marketplace course', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCertificateMarketplaceUniqueness2105000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "UQ_certificates_student_marketplace_course"');
    expect(sql).toContain('ON "certificates" ("student_id", "marketplace_course_id")');
    expect(sql).toContain('WHERE "marketplace_course_id" IS NOT NULL');
  });

  it('down() drops only the new index', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    await new AddCertificateMarketplaceUniqueness2105000000000().down({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('DROP INDEX IF EXISTS "UQ_certificates_student_marketplace_course"');
  });
});
