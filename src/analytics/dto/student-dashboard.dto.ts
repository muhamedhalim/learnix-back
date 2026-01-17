import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for student dashboard statistics
 */
export class StudentDashboardDto {
  @ApiProperty({
    description: 'Total number of lessons purchased',
    example: 12,
  })
  purchasedLessons!: number;

  @ApiProperty({
    description: 'Number of lessons attended (accessed)',
    example: 10,
  })
  attendedLessons!: number;

  @ApiProperty({
    description: 'Number of books owned',
    example: 5,
  })
  booksOwned!: number;

  @ApiProperty({
    description: 'Number of exams completed (graded)',
    example: 8,
  })
  examsCompleted!: number;

  @ApiProperty({
    description: 'Number of exams in progress (submitted but not graded)',
    example: 2,
  })
  examsInProgress!: number;

  @ApiProperty({
    description: 'Average score across all graded exams',
    example: 85.5,
    nullable: true,
  })
  averageScore!: number | null;

  @ApiProperty({
    description: 'Number of lessons with active access (not expired)',
    example: 3,
  })
  activeAccessCount!: number;
}
