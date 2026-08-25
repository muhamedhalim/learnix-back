import { ApiProperty } from '@nestjs/swagger';

import type { LessonWithDetails } from '../lessons.service';

class PublicLessonTeacherDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public name!: string;

  @ApiProperty({ nullable: true })
  public profile_picture_url!: string | null;
}

class PublicLessonSubjectDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public name!: string;

}

/**
 * Public catalogue representation. Raw video locations, provider identifiers,
 * storage keys and encoding metadata are deliberately absent. Playable media is
 * issued only by the access-checked signed playback endpoint.
 */
export class PublicLessonResponseDto {
  @ApiProperty()
  public id!: string;
  @ApiProperty()
  public title!: string;
  @ApiProperty({ nullable: true })
  public description!: string | null;
  @ApiProperty({ type: PublicLessonTeacherDto })
  public teacher!: PublicLessonTeacherDto;
  @ApiProperty({ type: PublicLessonSubjectDto })
  public subject!: PublicLessonSubjectDto;
  @ApiProperty({ nullable: true })
  public thumbnail_url!: string | null;
  @ApiProperty()
  public price!: number;
  @ApiProperty({ nullable: true })
  public duration!: number | null;
  @ApiProperty()
  public is_group!: boolean;
  @ApiProperty()
  public available_for_days!: number;
  @ApiProperty()
  public students_count!: number;
  @ApiProperty({
    description:
      'Count of this Individual Lesson\'s appointment slots a public buyer could book right now. Always 0 for group lessons.',
  })
  public available_sessions_count!: number;
  @ApiProperty({
    nullable: true,
    description: 'Earliest currently-bookable appointment start time, or null if none.',
  })
  public next_session_at!: Date | null;
  @ApiProperty()
  public created_at!: Date;
  @ApiProperty()
  public updated_at!: Date;
}

export function toPublicLessonResponse(
  lesson: LessonWithDetails,
  resolvePublicMedia: (value: string | null) => string | null,
): PublicLessonResponseDto {
  return {
    id: lesson.id,
    title: lesson.title,
    description: lesson.description,
    teacher: {
      id: lesson.teacher.id,
      name: lesson.teacher.name,
      profile_picture_url: resolvePublicMedia(lesson.teacher.profile_picture_url),
    },
    subject: lesson.subject,
    // Already resolved through the media proxy at the mapping layer
    // (LessonsService.mapToLessonWithDetails / mapListRowToLessonWithDetails).
    thumbnail_url: lesson.thumbnail_url,
    price: lesson.price,
    duration: lesson.duration,
    is_group: lesson.is_group,
    available_for_days: lesson.available_for_days,
    students_count: lesson.students_count,
    available_sessions_count: lesson.available_sessions_count,
    next_session_at: lesson.next_session_at,
    created_at: lesson.created_at,
    updated_at: lesson.updated_at,
  };
}
