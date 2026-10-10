import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for teacher dashboard statistics
 */
export class TeacherDashboardDto {
  @ApiProperty({
    description: 'Total number of lessons created by this teacher',
    example: 15,
  })
  public totalLessons!: number;

  @ApiProperty({
    description: 'Total number of books created by this teacher',
    example: 5,
  })
  public totalBooks!: number;

  @ApiProperty({
    description: 'Total number of exams created by this teacher',
    example: 8,
  })
  public totalExams!: number;

  @ApiProperty({
    description: 'Number of unique students who purchased from this teacher',
    example: 45,
  })
  public totalStudents!: number;

  @ApiProperty({
    description:
      'Net settled revenue (charged minus refunded) in the primary currency — the currency with the largest net revenue. See `revenueByCurrency` for every currency.',
    example: 35_000,
  })
  public revenue!: number;

  @ApiProperty({
    description: 'Net settled revenue this month in the primary currency',
    example: 5000,
  })
  public revenueThisMonth!: number;

  @ApiProperty({
    description:
      'Net settled revenue per currency (largest first). Additive: `revenue`/`revenueThisMonth` equal the first entry.',
    type: () => [TeacherRevenueByCurrencyDto],
  })
  public revenueByCurrency!: TeacherRevenueByCurrencyDto[];

  @ApiProperty({
    description: 'Average rating from all reviews',
    example: 4.5,
    nullable: true,
  })
  public averageRating!: number | null;

  @ApiProperty({
    description: 'Total number of reviews received',
    example: 30,
  })
  public totalReviews!: number;

  @ApiProperty({ description: 'Lesson viewing sessions in the selected period', example: 120 })
  public engagementViews!: number;
}

export class TeacherRevenueByCurrencyDto {
  @ApiProperty({ description: 'ISO 4217 currency code', example: 'EGP' })
  public currency!: string;

  @ApiProperty({ description: 'Net settled revenue (major units)', example: 35_000 })
  public amount!: number;

  @ApiProperty({ description: 'Net settled revenue this month (major units)', example: 5000 })
  public amountThisMonth!: number;
}
