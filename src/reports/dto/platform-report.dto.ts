import { ApiProperty } from '@nestjs/swagger';

import { ReportPeriodDto } from './teacher-report.dto';

export class PlatformUsersStatsDto {
  @ApiProperty({ description: 'Total registered users' })
  public totalUsers!: number;

  @ApiProperty({ description: 'Total students' })
  public students!: number;

  @ApiProperty({ description: 'Total teachers' })
  public teachers!: number;

  @ApiProperty({ description: 'Total admins' })
  public admins!: number;

  @ApiProperty({ description: 'New users in the period' })
  public newUsers!: number;

  @ApiProperty({ description: 'Active users (with activity in period)' })
  public activeUsers!: number;
}

export class PlatformRevenueStatsDto {
  @ApiProperty({ description: 'Total revenue in the period' })
  public totalRevenue!: number;

  @ApiProperty({ description: 'Revenue from lesson purchases' })
  public lessonsRevenue!: number;

  @ApiProperty({ description: 'Revenue from book purchases' })
  public booksRevenue!: number;

  @ApiProperty({ description: 'Revenue from package purchases' })
  public packagesRevenue!: number;
}

export class PlatformContentStatsDto {
  @ApiProperty({ description: 'Total lessons on platform' })
  public totalLessons!: number;

  @ApiProperty({ description: 'Total books on platform' })
  public totalBooks!: number;

  @ApiProperty({ description: 'Total exams on platform' })
  public totalExams!: number;

  @ApiProperty({ description: 'Total packages on platform' })
  public totalPackages!: number;
}

export class PlatformEngagementStatsDto {
  @ApiProperty({ description: 'Total lesson views in period' })
  public lessonViews!: number;

  @ApiProperty({ description: 'Total exam attempts in period' })
  public examAttempts!: number;

  @ApiProperty({ description: 'Average session duration in seconds' })
  public averageSessionDuration!: number;

  @ApiProperty({ description: 'Lesson completion rate (percentage)' })
  public completionRate!: number;
}

export class PlatformReportDto {
  @ApiProperty({ type: ReportPeriodDto, description: 'Report period' })
  public period!: ReportPeriodDto;

  @ApiProperty({ type: PlatformUsersStatsDto, description: 'User statistics' })
  public users!: PlatformUsersStatsDto;

  @ApiProperty({
    type: PlatformRevenueStatsDto,
    description: 'Revenue statistics',
  })
  public revenue!: PlatformRevenueStatsDto;

  @ApiProperty({
    type: PlatformContentStatsDto,
    description: 'Content statistics',
  })
  public content!: PlatformContentStatsDto;

  @ApiProperty({
    type: PlatformEngagementStatsDto,
    description: 'Engagement statistics',
  })
  public engagement!: PlatformEngagementStatsDto;
}
