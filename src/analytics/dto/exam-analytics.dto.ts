import { ApiProperty } from '@nestjs/swagger';

export class QuestionAnalysisDto {
  @ApiProperty({ description: 'Question index (0-based)' })
  public question_index!: number;

  @ApiProperty({ description: 'Question type (mcq or essay)' })
  public question_type!: string;

  @ApiProperty({ description: 'Number of correct answers (MCQ only)' })
  public correct_answers!: number;

  @ApiProperty({ description: 'Number of wrong answers (MCQ only)' })
  public wrong_answers!: number;

  @ApiProperty({
    description: 'Average score for this question',
    nullable: true,
  })
  public average_score!: number | null;

  @ApiProperty({ description: 'Maximum possible marks for this question' })
  public max_marks!: number;
}

export class ExamAnalyticsDto {
  @ApiProperty({ description: 'Exam ID' })
  public exam_id!: string;

  @ApiProperty({ description: 'Total graded submissions' })
  public total_submissions!: number;

  @ApiProperty({ description: 'Total in-progress attempts' })
  public in_progress_count!: number;

  @ApiProperty({ description: 'Total pending grading (essays)' })
  public pending_grading_count!: number;

  @ApiProperty({ description: 'Average total score', nullable: true })
  public average_score!: number | null;

  @ApiProperty({ description: 'Highest total score', nullable: true })
  public highest_score!: number | null;

  @ApiProperty({ description: 'Lowest total score', nullable: true })
  public lowest_score!: number | null;

  @ApiProperty({ description: 'Pass rate percentage (0-100)', nullable: true })
  public pass_rate!: number | null;

  @ApiProperty({
    description: 'Per-question analysis',
    type: [QuestionAnalysisDto],
  })
  public question_analysis!: QuestionAnalysisDto[];

  @ApiProperty({ description: 'Score distribution buckets' })
  public score_distribution!: {
    '0-20': number;
    '21-40': number;
    '41-60': number;
    '61-80': number;
    '81-100': number;
  };

  @ApiProperty({
    description: 'Data timestamp (when analytics were calculated)',
  })
  public calculated_at!: Date;
}
