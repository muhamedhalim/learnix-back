import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO for admin dashboard statistics
 */
export class AdminDashboardDto {
  @ApiProperty({
    description: 'Total number of approved students',
    example: 150,
  })
  totalStudents!: number;

  @ApiProperty({
    description: 'Number of students pending approval',
    example: 5,
  })
  pendingStudents!: number;

  @ApiProperty({
    description: 'Number of approved students',
    example: 145,
  })
  approvedStudents!: number;

  @ApiProperty({
    description: 'Total number of approved teachers',
    example: 20,
  })
  totalTeachers!: number;

  @ApiProperty({
    description: 'Number of teachers pending approval',
    example: 2,
  })
  pendingTeachers!: number;

  @ApiProperty({
    description: 'Number of approved teachers',
    example: 18,
  })
  approvedTeachers!: number;

  @ApiProperty({
    description: 'Total number of active lessons',
    example: 75,
  })
  totalLessons!: number;

  @ApiProperty({
    description: 'Total number of active books',
    example: 30,
  })
  totalBooks!: number;

  @ApiProperty({
    description: 'Total revenue from all completed transactions',
    example: 125000.5,
  })
  totalRevenue!: number;

  @ApiProperty({
    description: 'Revenue earned this month',
    example: 15000.0,
  })
  revenueThisMonth!: number;

  @ApiProperty({
    description: 'Revenue earned last month',
    example: 12500.0,
  })
  revenueLastMonth!: number;
}
