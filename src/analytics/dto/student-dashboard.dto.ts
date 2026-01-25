import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for student dashboard statistics
 */
export class StudentDashboardDto {
  @ApiProperty({
    description: 'Total number of lessons purchased',
    example: 12,
  })
  public purchasedLessons!: number;

  @ApiProperty({
    description: 'Number of lessons attended (accessed)',
    example: 10,
  })
  public attendedLessons!: number;

  @ApiProperty({
    description: 'Number of books owned',
    example: 5,
  })
  public booksOwned!: number;

  @ApiProperty({
    description: 'Number of exams completed (graded)',
    example: 8,
  })
  public examsCompleted!: number;

  @ApiProperty({
    description: 'Number of exams in progress (submitted but not graded)',
    example: 2,
  })
  public examsInProgress!: number;

  @ApiProperty({
    description: 'Average score across all graded exams',
    example: 85.5,
    nullable: true,
  })
  public averageScore!: number | null;

  @ApiProperty({
    description: 'Number of lessons with active access (not expired)',
    example: 3,
  })
  public activeAccessCount!: number;
}
