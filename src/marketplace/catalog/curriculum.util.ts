import { In, Repository } from 'typeorm';

import { MarketplaceCourseLesson } from './entities';

/**
 * The lessons of every given section in one statement (T071), grouped back into
 * the sections' own order. The repository API is the one the per-section reads
 * used, so soft-delete handling is unchanged; a section with no lessons yields
 * `[]`, exactly what its own `find` returned.
 */
export async function loadLessonsBySection(
  lessons: Repository<MarketplaceCourseLesson>,
  sections: ReadonlyArray<{ id: string }>,
): Promise<MarketplaceCourseLesson[][]> {
  if (sections.length === 0) return [];
  const rows = await lessons.find({
    where: { section_id: In(sections.map((section) => section.id)) },
    order: { section_id: 'ASC', position: 'ASC' },
  });
  const bySection = new Map<string, MarketplaceCourseLesson[]>();
  for (const row of rows) {
    const bucket = bySection.get(row.section_id);
    if (bucket) bucket.push(row);
    else bySection.set(row.section_id, [row]);
  }
  return sections.map((section) => bySection.get(section.id) ?? []);
}
