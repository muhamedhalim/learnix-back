import { ApiProperty } from '@nestjs/swagger';

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
    description: 'Total revenue from all completed transactions',
    example: 125000.5,
  })
  public totalRevenue!: number;

  @ApiProperty({
    description: 'Revenue earned this month',
    example: 15000.0,
  })
  public revenueThisMonth!: number;

  @ApiProperty({
    description: 'Revenue earned last month',
    example: 12500.0,
  })
  public revenueLastMonth!: number;
}
