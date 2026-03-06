import { ApiProperty } from '@nestjs/swagger';

export class SubjectProgressDto {
  @ApiProperty({ description: 'Subject ID (UUID)' })
  public subjectId!: string;

  @ApiProperty({ description: 'Subject name' })
  public subjectName!: string;

  @ApiProperty({ description: 'Number of lessons completed' })
  public lessonsCompleted!: number;

  @ApiProperty({ description: 'Total lessons in subject' })
  public lessonsTotal!: number;

  @ApiProperty({ description: 'Average exam score for this subject' })
  public averageScore!: number | null;

  @ApiProperty({ description: 'Progress percentage (0-100)' })
  public progressPercent!: number;
}

export class StudentProgressReportDto {
  @ApiProperty({
    description: 'Overall progress percentage across all subjects',
  })
  public overallProgress!: number;

  @ApiProperty({
    type: [SubjectProgressDto],
    description: 'Progress breakdown by subject',
  })
  public subjects!: SubjectProgressDto[];

  @ApiProperty({
    type: [String],
    description: 'Areas where student excels',
  })
  public strengths!: string[];

  @ApiProperty({
    type: [String],
    description: 'Areas that need improvement',
  })
  public needsImprovement!: string[];
}
