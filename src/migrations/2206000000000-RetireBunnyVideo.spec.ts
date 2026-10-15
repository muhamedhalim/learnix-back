import { RetireBunnyVideo2206000000000 } from './2206000000000-RetireBunnyVideo';

/** Answers the two counting queries, records every statement. */
function runner(legacyLessons: number, legacyMarketplace: number) {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('FROM "lessons"') && sql.includes('count(*)')) return [{ n: legacyLessons }];
    if (sql.includes('FROM "marketplace_course_lessons"') && sql.includes('count(*)')) {
      return [{ n: legacyMarketplace }];
    }
    return [];
  });
  return { query, statements };
}

describe('RetireBunnyVideo2206000000000', () => {
  const original = process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'];
  afterEach(() => {
    if (original === undefined) delete process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'];
    else process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'] = original;
  });

  it('applies cleanly to a database with no Bunny-hosted lesson, without any archive write', async () => {
    delete process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'];
    const { query, statements } = runner(0, 0);

    await new RetireBunnyVideo2206000000000().up({ query } as never);

    expect(statements.some((s) => s.includes('INSERT INTO "legacy_bunny_video_references"'))).toBe(
      false,
    );
    expect(
      statements.some((s) => s.includes('RENAME COLUMN "bunny_video_status" TO "video_status"')),
    ).toBe(true);
    expect(statements.some((s) => s.includes('"video_platform" DROP NOT NULL'))).toBe(true);
  });

  it('refuses, changing nothing, while a lesson still points at a Bunny video and the operator has not confirmed', async () => {
    delete process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'];
    const { query, statements } = runner(2, 1);

    await expect(new RetireBunnyVideo2206000000000().up({ query } as never)).rejects.toThrow(
      /2 academic lesson\(s\) and 1 marketplace lesson\(s\).*ARCHIVE_LEGACY_BUNNY_VIDEOS=true/s,
    );

    expect(statements.every((s) => s.includes('count(*)'))).toBe(true);
  });

  it('archives the links before clearing them once the operator confirms', async () => {
    process.env['ARCHIVE_LEGACY_BUNNY_VIDEOS'] = 'true';
    const { query, statements } = runner(1, 1);

    await new RetireBunnyVideo2206000000000().up({ query } as never);

    const archiveLessons = statements.findIndex((s) => s.includes(`SELECT 'lessons'`));
    const clearLessons = statements.findIndex((s) => s.startsWith('UPDATE "lessons"'));
    const archiveMarketplace = statements.findIndex((s) =>
      s.includes(`SELECT 'marketplace_course_lessons'`),
    );
    const clearMarketplace = statements.findIndex((s) =>
      s.startsWith('UPDATE "marketplace_course_lessons"'),
    );
    expect(archiveLessons).toBeGreaterThan(-1);
    expect(clearLessons).toBeGreaterThan(archiveLessons);
    expect(archiveMarketplace).toBeGreaterThan(-1);
    expect(clearMarketplace).toBeGreaterThan(archiveMarketplace);
    // AWS-hosted videos are never touched.
    expect(
      statements
        .filter((s) => s.startsWith('UPDATE'))
        .every((s) => s.includes('IS NULL') || s.includes("NOT LIKE 'aws:%'")),
    ).toBe(true);
  });

  it('restores the archived links and the column shape on the way down, and never drops the archive', async () => {
    const { query, statements } = runner(0, 0);

    await new RetireBunnyVideo2206000000000().down({ query } as never);

    expect(
      statements.some((s) => s.includes('RENAME COLUMN "video_status" TO "bunny_video_status"')),
    ).toBe(true);
    expect(statements.some((s) => s.includes('FROM "legacy_bunny_video_references"'))).toBe(true);
    expect(statements.some((s) => /DROP TABLE/i.test(s))).toBe(false);
  });
});
