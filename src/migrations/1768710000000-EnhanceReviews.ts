import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enhance the reviews system:
 *  - moderation status + denormalised helpful_count on both review tables
 *  - teacher reply columns on lesson_reviews
 *  - review_helpful_votes table (one vote per user per review)
 */
export class EnhanceReviews1768710000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE review_status_enum AS ENUM ('approved', 'flagged', 'rejected');
    `);

    // lesson_reviews: status + helpful_count + teacher reply
    await queryRunner.query(`
      ALTER TABLE lesson_reviews
        ADD COLUMN status review_status_enum NOT NULL DEFAULT 'approved',
        ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN teacher_reply TEXT,
        ADD COLUMN teacher_reply_at TIMESTAMPTZ;
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_lesson_reviews_status" ON lesson_reviews(status);
    `);

    // teacher_reviews: status + helpful_count
    await queryRunner.query(`
      ALTER TABLE teacher_reviews
        ADD COLUMN status review_status_enum NOT NULL DEFAULT 'approved',
        ADD COLUMN helpful_count INTEGER NOT NULL DEFAULT 0;
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_teacher_reviews_status" ON teacher_reviews(status);
    `);

    // review_helpful_votes
    await queryRunner.query(`
      CREATE TYPE review_target_type_enum AS ENUM ('lesson', 'teacher');
    `);
    await queryRunner.query(`
      CREATE TABLE review_helpful_votes (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        review_type review_target_type_enum NOT NULL,
        review_id UUID NOT NULL,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_review_helpful_vote" UNIQUE (review_type, review_id, user_id)
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_review_helpful_votes_target"
        ON review_helpful_votes(review_type, review_id);
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_review_helpful_votes_user"
        ON review_helpful_votes(user_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS review_helpful_votes;`);
    await queryRunner.query(`DROP TYPE IF EXISTS review_target_type_enum;`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_teacher_reviews_status";`);
    await queryRunner.query(`
      ALTER TABLE teacher_reviews
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS helpful_count;
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_lesson_reviews_status";`);
    await queryRunner.query(`
      ALTER TABLE lesson_reviews
        DROP COLUMN IF EXISTS status,
        DROP COLUMN IF EXISTS helpful_count,
        DROP COLUMN IF EXISTS teacher_reply,
        DROP COLUMN IF EXISTS teacher_reply_at;
    `);

    await queryRunner.query(`DROP TYPE IF EXISTS review_status_enum;`);
  }
}
