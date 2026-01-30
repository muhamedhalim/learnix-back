import { ApiProperty } from '@nestjs/swagger';

export class LessonAnalyticsDto {
  @ApiProperty({ description: 'Lesson ID' })
  public lesson_id!: string;

  @ApiProperty({ description: 'Total purchases (direct + via packages)' })
  public total_purchases!: number;

  @ApiProperty({ description: 'Total viewing sessions' })
  public total_views!: number;

  @ApiProperty({ description: 'Average watch time in seconds' })
  public average_watch_time_seconds!: number;

  @ApiProperty({
    description: 'Completion rate (% of sessions with 90%+ progress)',
  })
  public completion_rate!: number;

  @ApiProperty({ description: 'Total revenue from purchases' })
  public revenue!: number;

  @ApiProperty({ description: 'Average rating (1-5)', nullable: true })
  public average_rating!: number | null;

  @ApiProperty({ description: 'Total number of reviews' })
  public total_reviews!: number;

  @ApiProperty({ description: 'Revenue breakdown by source' })
  public revenue_breakdown!: {
    direct_purchases: number;
    package_purchases: number;
  };

  @ApiProperty({
    description: 'Data timestamp (when analytics were calculated)',
  })
  public calculated_at!: Date;
}
