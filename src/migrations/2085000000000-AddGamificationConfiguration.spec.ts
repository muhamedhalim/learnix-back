import { AddGamificationConfiguration2085000000000 } from './2085000000000-AddGamificationConfiguration';

describe('AddGamificationConfiguration2085000000000', () => {
  const runUp = async (): Promise<jest.Mock> => {
    const query = jest.fn().mockResolvedValue([]);
    await new AddGamificationConfiguration2085000000000().up({ query } as never);
    return query;
  };

  it('adds the campaign_bonus enum value without using it in the same transaction', async () => {
    const statements = (await runUp()).mock.calls.map((call) => String(call[0]));
    const enumAlter = statements.find((sql) => sql.includes('xp_events_reason_enum'));

    expect(enumAlter).toContain(`ADD VALUE IF NOT EXISTS 'campaign_bonus'`);
    // The new value must not be referenced by any other statement in this
    // migration (Postgres forbids using it in the same transaction it was added in).
    expect(statements.some((sql) => sql !== enumAlter && sql.includes('campaign_bonus'))).toBe(false);
  });

  it('creates both new tables additively, never touching an existing table', async () => {
    const statements = (await runUp()).mock.calls.map((call) => String(call[0]));
    const creates = statements.filter((sql) => sql.includes('CREATE TABLE'));

    expect(creates).toHaveLength(2);
    expect(creates.join('\n')).toContain('"gamification_rule_sets"');
    expect(creates.join('\n')).toContain('"gamification_campaigns"');
    for (const sql of statements) {
      expect(sql).not.toMatch(/ALTER TABLE\s+"(?!gamification_)/);
      expect(sql).not.toMatch(/\bDROP\b/i);
    }
  });

  it('scopes gamification_campaigns to a teacher-owned lesson via FK constraints', async () => {
    const statements = (await runUp()).mock.calls.map((call) => String(call[0]));
    const campaignsTable = statements.find((sql) => sql.includes('CREATE TABLE "gamification_campaigns"'));

    expect(campaignsTable).toContain('FOREIGN KEY ("teacher_id") REFERENCES "users"("id")');
    expect(campaignsTable).toContain('FOREIGN KEY ("lesson_id") REFERENCES "lessons"("id")');
  });

  it('bootstraps version 1 as an exact mirror of gamification.constants.ts, idempotently', async () => {
    const statements = (await runUp()).mock.calls.map((call) => String(call[0]));
    const seed = statements.find((sql) => sql.includes('INSERT INTO "gamification_rule_sets"'));

    expect(seed).toBeDefined();
    expect(seed).toContain('{"easy":10,"medium":20,"hard":35,"expert":55}');
    expect(seed).toContain('[{"at":5,"xp":15},{"at":10,"xp":40},{"at":20,"xp":100}]');
    expect(seed).toContain('[{"days":7,"xp":100},{"days":30,"xp":500},{"days":100,"xp":2000}]');
    expect(seed).toContain('25');
    expect(seed).toContain('ON CONFLICT ("version_number") DO NOTHING');
  });

  it('down() drops only the two new tables and never the enum type', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new AddGamificationConfiguration2085000000000().down({ query } as never);

    const statements = query.mock.calls.map((call) => String(call[0]));
    expect(statements).toHaveLength(2);
    expect(statements.join('\n')).toContain('DROP TABLE IF EXISTS "gamification_campaigns"');
    expect(statements.join('\n')).toContain('DROP TABLE IF EXISTS "gamification_rule_sets"');
    expect(statements.some((sql) => sql.includes('DROP TYPE'))).toBe(false);
  });
});
