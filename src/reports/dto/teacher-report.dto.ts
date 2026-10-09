import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReportPeriodDto {
  @ApiProperty({ description: 'Start date of the report period' })
  public from!: string;

  @ApiProperty({ description: 'End date of the report period' })
  public to!: string;
}

export class RevenueBreakdownDto {
  @ApiProperty({ description: 'Total revenue in the period' })
  public total!: number;

  @ApiProperty({ description: 'Revenue from lesson purchases' })
  public lessons!: number;

  @ApiProperty({ description: 'Revenue from book purchases' })
  public books!: number;

  @ApiProperty({ description: 'Revenue from package purchases' })
  public packages!: number;
}

export class TeacherStudentsStatsDto {
  @ApiProperty({ description: 'Total unique students' })
  public total!: number;

  @ApiProperty({ description: 'New students in the period' })
  public newInPeriod!: number;

  @ApiProperty({ description: 'Active students (with recent activity)' })
  public active!: number;
}

export class TeacherLessonsStatsDto {
  @ApiProperty({ description: 'Total lessons created' })
  public totalLessons!: number;

  @ApiProperty({ description: 'Total lesson views in period' })
  public totalViews!: number;

  @ApiPropertyOptional({ description: 'Average rating (null if no ratings)' })
  public averageRating!: number | null;
}

export class TeacherExamsStatsDto {
  @ApiProperty({ description: 'Total exams created' })
  public totalExams!: number;

  @ApiProperty({ description: 'Total exam attempts in period' })
  public totalAttempts!: number;

  @ApiPropertyOptional({ description: 'Average score (null if no attempts)' })
  public averageScore!: number | null;
}

export class TeacherGuardianStatsDto {
  @ApiProperty({ description: 'Distinct guardians linked to this teacher\'s students' })
  public total!: number;

  @ApiProperty({ description: 'Guardians who have completed OTP verification' })
  public verified!: number;

  @ApiProperty({ description: 'Guardians not yet verified' })
  public pending!: number;
}

export class TeacherNotificationStatsDto {
  @ApiProperty({ description: 'Notifications about this teacher\'s students sent today' })
  public today!: number;

  @ApiProperty({ description: 'Share of provider-accepted messages later confirmed delivered' })
  public deliveryRate!: number;

  @ApiProperty({ description: 'Share of provider-accepted messages later confirmed read' })
  public readRate!: number;
}

export class TeacherReportDto {
  @ApiProperty({ type: ReportPeriodDto, description: 'Report period' })
  public period!: ReportPeriodDto;

  @ApiProperty({ type: RevenueBreakdownDto, description: 'Revenue breakdown' })
  public revenue!: RevenueBreakdownDto;

  @ApiProperty({
    type: TeacherStudentsStatsDto,
    description: 'Student statistics',
  })
  public students!: TeacherStudentsStatsDto;

  @ApiProperty({
    type: TeacherLessonsStatsDto,
    description: 'Lesson statistics',
  })
  public lessons!: TeacherLessonsStatsDto;

  @ApiProperty({ type: TeacherExamsStatsDto, description: 'Exam statistics' })
  public exams!: TeacherExamsStatsDto;

  @ApiProperty({ type: TeacherGuardianStatsDto, description: 'Guardian verification statistics' })
  public guardians!: TeacherGuardianStatsDto;

  @ApiProperty({ type: TeacherNotificationStatsDto, description: 'Parent notification statistics' })
  public notifications!: TeacherNotificationStatsDto;

  @ApiProperty({ description: 'Students currently flagged at any risk level (low/medium/high/critical, excluding none)' })
  public riskStudentCount!: number;
}

/** `GET /reports/teacher/follow-up`: the three follow-up figures of `TeacherReportDto`, without the range-bound reads. */
export class TeacherFollowUpSummaryDto {
  @ApiProperty({ type: TeacherGuardianStatsDto, description: 'Guardian verification statistics' })
  public guardians!: TeacherGuardianStatsDto;

  @ApiProperty({ type: TeacherNotificationStatsDto, description: 'Parent notification statistics' })
  public notifications!: TeacherNotificationStatsDto;

  @ApiProperty({ description: 'Students currently flagged at any risk level (low/medium/high/critical, excluding none)' })
  public riskStudentCount!: number;
}
