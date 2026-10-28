import { Injectable } from '@nestjs/common';
import { SelectQueryBuilder } from 'typeorm';

import { normalizeArabicQuery } from '../../common/utils/arabic-search.util';
import { MarketplaceCourse } from '../catalog/entities';

/**
 * FR-078, FR-081. Bilingual keyword search over course title/summary/description,
 * category name and instructor display name, in English and Arabic.
 *
 * Deliberately uses only stock Postgres functions (`lower`, `translate`) —
 * no generated column, no custom SQL function like the academic
 * `learnix_normalize_search_text()`. Both of those are migration-only
 * artifacts, and this feature's e2e suite builds its schema via TypeORM
 * `synchronize` from entity definitions, never by running migrations
 * (`test/global-setup-e2e.ts`'s documented constraint) — a generated column
 * or a `CREATE FUNCTION` would work in production and always throw
 * ("column/function does not exist") in e2e. `translate()` folds the same
 * hamza/alef-maksura/teh-marbuta variants `normalizeArabicQuery` folds in
 * JS (diacritic-stripping is JS-only — an acceptable gap for
 * instructor-typed titles, which essentially never carry tashkeel).
 * GIN-trigram indexing for FR-331's 50k-course scale target is T212's job,
 * not this one.
 */
@Injectable()
export class CatalogSearchService {
  /** `translate()`'s from/to lists — the Arabic variant-folding half of `normalizeArabicQuery`. */
  private static readonly TRANSLATE_FROM = 'آأإٱىة';
  private static readonly TRANSLATE_TO = 'اااايه';

  /**
   * Adds the search WHERE clause and a `relevance` SELECT to `qb` — assumes
   * `course.instructor` and `course.category` are already joined (as
   * `CatalogQueryService.baseVisibleQuery()` always does). Returns whether a
   * usable term was supplied, so the caller knows whether to order by
   * relevance or fall back to its own default sort.
   */
  public applySearch(qb: SelectQueryBuilder<MarketplaceCourse>, rawKeyword: string): boolean {
    const normalized = normalizeArabicQuery(rawKeyword);
    if (!normalized) return false;

    const like = this.likePattern(normalized);
    const courseText = this.foldExpr(
      "coalesce(course.title, '') || ' ' || coalesce(course.title_ar, '') || ' ' || coalesce(course.summary, '') || ' ' || coalesce(course.summary_ar, '') || ' ' || coalesce(course.description, '') || ' ' || coalesce(course.description_ar, '')",
    );
    const categoryText = this.foldExpr("coalesce(category.name_en, '') || ' ' || coalesce(category.name_ar, '')");
    const instructorText = this.foldExpr("coalesce(instructor.display_name, '')");

    qb.andWhere(`(${courseText} ILIKE :searchLike ESCAPE '\\' OR ${categoryText} ILIKE :searchLike ESCAPE '\\' OR ${instructorText} ILIKE :searchLike ESCAPE '\\')`, {
      searchLike: like,
    });

    const titleText = this.foldExpr("coalesce(course.title, '') || ' ' || coalesce(course.title_ar, '')");
    const summaryText = this.foldExpr("coalesce(course.summary, '') || ' ' || coalesce(course.summary_ar, '')");
    const descriptionText = this.foldExpr("coalesce(course.description, '') || ' ' || coalesce(course.description_ar, '')");
    qb.addSelect(
      `CASE
        WHEN ${titleText} ILIKE :searchLike ESCAPE '\\' THEN 4
        WHEN ${summaryText} ILIKE :searchLike ESCAPE '\\' THEN 3
        WHEN ${descriptionText} ILIKE :searchLike ESCAPE '\\' THEN 2
        ELSE 1
      END`,
      'course_relevance',
    );
    qb.orderBy('course_relevance', 'DESC');
    return true;
  }

  /** `lower(translate(expr, from, to))` — the portable, index-free equivalent of `learnix_normalize_search_text`. */
  private foldExpr(sqlExpression: string): string {
    return `lower(translate(${sqlExpression}, '${CatalogSearchService.TRANSLATE_FROM}', '${CatalogSearchService.TRANSLATE_TO}'))`;
  }

  private likePattern(q: string): string {
    return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  }
}
