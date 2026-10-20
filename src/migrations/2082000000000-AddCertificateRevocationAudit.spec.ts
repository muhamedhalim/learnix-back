import { AddCertificateRevocationAudit2082000000000 } from './2082000000000-AddCertificateRevocationAudit';

describe('AddCertificateRevocationAudit2082000000000', () => {
  const runUp = async (): Promise<jest.Mock> => {
    const query = jest.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('COUNT(*)::int')) return Promise.resolve([{ count: 0 }]);
      return Promise.resolve([]);
    });
    // eslint-disable-next-line no-console
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await new AddCertificateRevocationAudit2082000000000().up({ query } as never);
    return query;
  };

  afterEach(() => jest.restoreAllMocks());

  it('adds the revocation audit columns without rewriting existing ones', async () => {
    const statements = (await runUp()).mock.calls.map((call) => String(call[0]));
    const ddl = statements.filter((sql) => sql.includes('ALTER TABLE'));

    expect(ddl).toHaveLength(3);
    for (const sql of ddl) expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(ddl.join('\n')).toContain('"certificates" ADD COLUMN IF NOT EXISTS "revoked_by"');
    expect(ddl.join('\n')).toContain(
      '"certificates" ADD COLUMN IF NOT EXISTS "revocation_context"',
    );
    expect(ddl.join('\n')).toContain(
      '"certificate_history" ADD COLUMN IF NOT EXISTS "revocation_context"',
    );
  });

  it('revokes only certificates whose course purchase was fully refunded and not re-bought', async () => {
    const backfill = (await runUp()).mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes('refunded_course_access'));

    expect(backfill).toBeDefined();
    // Cause must be a COMPLETED full refund, evidenced by the order status.
    expect(backfill).toContain("o.status = 'refunded'");
    expect(backfill).toContain('pp.revoked_at IS NOT NULL');
    // Never downgrade an already-revoked row, and never touch a course the
    // student still validly holds.
    expect(backfill).toContain(`c."status" = 'issued'`);
    expect(backfill).toContain('live.revoked_at IS NULL');
    expect(backfill).toContain(`'source', 'refund_backfill'`);
  });

  it('never deletes a certificate or mutates financial records', async () => {
    const statements = (await runUp()).mock.calls.map((call) => String(call[0]));

    for (const sql of statements) {
      expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP TABLE\b/i);
      expect(sql).not.toMatch(
        /UPDATE\s+"?(orders|refunds|payments|package_purchases|entitlements)"?/i,
      );
    }
  });

  it('rolls back only the rows it revoked itself', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AddCertificateRevocationAudit2082000000000().down({ query } as never);

    const revert = query.mock.calls
      .map((call) => String(call[0]))
      .find((sql) => sql.includes('UPDATE'));
    expect(revert).toContain(`"revocation_context" ->> 'source' = 'refund_backfill'`);
  });
});

describe('AddCertificateRevocationAudit2082000000000 backfill count (FIA-003)', () => {
  /** What TypeORM's Postgres query runner really returns: `[rows, rowCount]` for UPDATE … RETURNING. */
  function queryRunner(revokedRows: number) {
    const query = jest.fn(async (statement: string) => {
      if (statement.includes('RETURNING c."id"')) {
        return [
          Array.from({ length: revokedRows }, (_, i) => ({ id: `c${String(i)}` })),
          revokedRows,
        ];
      }
      if (statement.includes('SELECT COUNT(*)::int AS count')) return [{ count: 4 }];
      return undefined;
    });
    return { query } as never;
  }

  afterEach(() => jest.restoreAllMocks());

  it.each([0, 1, 37])(
    'logs the number of certificates the backfill actually revoked (%i)',
    async (revoked) => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

      await new AddCertificateRevocationAudit2082000000000().up(queryRunner(revoked));

      const line = log.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.startsWith('[DEF-019]'));
      expect(line).toContain(`Revoked ${String(revoked)} certificate(s)`);
      expect(line).toContain('4 certificate(s) have no purchase record');
    },
  );
});
