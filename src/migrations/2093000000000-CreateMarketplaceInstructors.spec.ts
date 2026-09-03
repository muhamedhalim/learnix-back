import { CreateMarketplaceInstructors2093000000000 } from './2093000000000-CreateMarketplaceInstructors';

describe('CreateMarketplaceInstructors migration', () => {
  it('creates both tables with the FR-015 partial-unique and reject-reason constraints', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceInstructors2093000000000().up({ query } as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('"marketplace_instructor_applications"');
    expect(sql).toContain('"marketplace_instructors"');
    expect(sql).toContain('UQ_mp_applications_user_open');
    expect(sql).toContain("WHERE \"status\" IN ('draft','submitted','under_review','approved')");
    expect(sql).toContain('CHK_mp_applications_reject_reason');
    expect(sql).toContain('UQ_mp_instructors_user_id');
    expect(sql).toContain('UQ_mp_instructors_slug');
    expect(sql).toContain('CHK_mp_instructors_suspension_reason');
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE FROM\b/);
  });

  it('down() cleanly drops both tables, applications last', async () => {
    const query = jest.fn().mockResolvedValue(undefined);

    await new CreateMarketplaceInstructors2093000000000().down({ query } as never);

    const calls = query.mock.calls.map(([statement]) => String(statement));
    expect(calls[0]).toContain('DROP TABLE IF EXISTS "marketplace_instructors"');
    expect(calls[1]).toContain('DROP TABLE IF EXISTS "marketplace_instructor_applications"');
  });
});
