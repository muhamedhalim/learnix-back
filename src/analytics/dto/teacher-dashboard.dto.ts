import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for teacher dashboard statistics
 */
export class TeacherDashboardDto {
  @ApiProperty({
    description: 'Total number of lessons created by this teacher',
    example: 15,
  })
  totalLessons!: number;

  @ApiProperty({
    description: 'Total number of books created by this teacher',
    example: 5,
  })
  totalBooks!: number;

  @ApiProperty({
    description: 'Total number of exams created by this teacher',
    example: 8,
  })
  totalExams!: number;

  @ApiProperty({
    description: 'Number of unique students who purchased from this teacher',
    example: 45,
  })
  totalStudents!: number;

  @ApiProperty({
    description: 'Total revenue earned by this teacher',
    example: 35000.0,
  })
  revenue!: number;

  @ApiProperty({
    description: 'Revenue earned this month',
    example: 5000.0,
  })
  revenueThisMonth!: number;

  @ApiProperty({
    description: 'Average rating from all reviews',
    example: 4.5,
    nullable: true,
  })
  averageRating!: number | null;

  @ApiProperty({
    description: 'Total number of reviews received',
    example: 30,
  })
  totalReviews!: number;
}
