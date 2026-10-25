import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Zoom's `start_url` embeds a host token (ZAK) that lets whoever holds it start
 * the meeting as the teacher. It was stored in `meeting_host_url` and returned
 * in teacher/admin session payloads, though nothing used it. The adapter no
 * longer persists it; this clears the values already stored. Data-only and
 * idempotent; `down` is a no-op because the removed values were credentials
 * and must not be restored.
 */
export class ClearZoomHostUrls2210000000000 implements MigrationInterface {
  public name = 'ClearZoomHostUrls2210000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "scheduled_lesson_sessions"
          SET "meeting_host_url" = NULL
        WHERE "meeting_provider" = 'zoom' AND "meeting_host_url" IS NOT NULL`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty — see class comment.
  }
}
