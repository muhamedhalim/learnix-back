import { ApiProperty } from '@nestjs/swagger';

class TeacherPreviewDto {
  @ApiProperty({ description: 'Teacher ID' })
  public id!: string;

  @ApiProperty({ description: 'Teacher name' })
  public name!: string;
}

class SubjectPreviewDto {
  @ApiProperty({ description: 'Subject ID' })
  public id!: string;

  @ApiProperty({ description: 'Subject name' })
  public name!: string;

  @ApiProperty({ description: 'Grade level (e.g., "10", "11", "12")' })
  public grade_level!: string;
}

export class ExamPreviewResponseDto {
  @ApiProperty({ description: 'Exam ID (UUID)' })
  public id!: string;

  @ApiProperty({ description: 'Exam title in English' })
  public title!: string;

  @ApiProperty({ description: 'Exam title in Arabic', nullable: true })
  public title_ar!: string | null;

  @ApiProperty({ description: 'Exam description', nullable: true })
  public description!: string | null;

  @ApiProperty({ description: 'Duration in minutes' })
  public duration_minutes!: number;

  @ApiProperty({ description: 'Total number of questions' })
  public questions_count!: number;

  @ApiProperty({ description: 'Number of MCQ questions' })
  public mcq_count!: number;

  @ApiProperty({ description: 'Number of essay questions' })
  public essay_count!: number;

  @ApiProperty({ description: 'Total marks for the exam' })
  public total_marks!: number;

  @ApiProperty({ description: 'Minimum marks required to pass' })
  public passing_marks!: number;

  @ApiProperty({ description: 'Teacher information', type: TeacherPreviewDto })
  public teacher!: TeacherPreviewDto;

  @ApiProperty({ description: 'Subject information', type: SubjectPreviewDto })
  public subject!: SubjectPreviewDto;
}
