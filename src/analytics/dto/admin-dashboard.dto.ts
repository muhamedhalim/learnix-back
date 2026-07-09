import { ApiProperty } from '@nestjs/swagger';

export class RevenueBySourceDto {
  @ApiProperty({ example: 75_000 })
  public lessons!: number;

  @ApiProperty({ example: 35_000 })
  public packages!: number;

  @ApiProperty({ example: 15_000 })
  public books!: number;
}

/**
 * Response DTO for admin dashboard statistics
 */
export class AdminDashboardDto {
  @ApiProperty({
    description: 'Total number of approved students',
    example: 150,
  })
  public totalStudents!: number;

  @ApiProperty({
    description: 'Number of students pending approval',
    example: 5,
  })
  public pendingStudents!: number;

  @ApiProperty({
    description: 'Number of approved students',
    example: 145,
  })
  public approvedStudents!: number;

  @ApiProperty({
    description: 'Total number of approved teachers',
    example: 20,
  })
  public totalTeachers!: number;

  @ApiProperty({
    description: 'Number of teachers pending approval',
    example: 2,
  })
  public pendingTeachers!: number;

  @ApiProperty({
    description: 'Number of approved teachers',
    example: 18,
  })
  public approvedTeachers!: number;

  @ApiProperty({
    description: 'Total number of active lessons',
    example: 75,
  })
  public totalLessons!: number;

  @ApiProperty({
    description: 'Total number of active books',
    example: 30,
  })
  public totalBooks!: number;

  @ApiProperty({
    description: 'Total number of active exams',
    example: 25,
  })
  public totalExams!: number;

  @ApiProperty({
    description: 'Total revenue from all completed transactions',
    example: 125_000.5,
  })
  public totalRevenue!: number;

  @ApiProperty({
    description: 'Revenue earned this month',
    example: 15_000,
  })
  public revenueThisMonth!: number;

  @ApiProperty({
    description: 'Revenue earned last month',
    example: 12_500,
  })
  public revenueLastMonth!: number;

  @ApiProperty({
    description: 'Revenue earned today (UTC)',
    example: 1_250,
  })
  public revenueToday!: number;

  @ApiProperty({
    description: 'Revenue earned this calendar quarter (UTC)',
    example: 42_000,
  })
  public revenueThisQuarter!: number;

  @ApiProperty({
    description: 'All-time completed revenue grouped by purchased item type',
    type: RevenueBySourceDto,
  })
  public revenueBySource!: RevenueBySourceDto;
}
