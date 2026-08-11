import { ApiProperty } from '@nestjs/swagger';

import type {
  CertificateEntry,
  EducationEntry,
  TeacherProfile,
} from '../entities/teacher-profile.entity';

export class PublicTeacherSubjectDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public name!: string;

}

/**
 * Stable allowlisted representation for every anonymous teacher response.
 * Account email, phone, username, status and administrative fields are
 * intentionally absent, so adding a column to User cannot expose it here.
 */
export class PublicTeacherResponseDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public name!: string;

  /** Resolved public avatar URL. It is deliberately not a nested User field. */
  @ApiProperty({ nullable: true })
  public profile_picture_url!: string | null;

  @ApiProperty()
  public qualifications!: string;

  @ApiProperty()
  public years_of_experience!: number;

  @ApiProperty({ nullable: true })
  public bio!: string | null;

  @ApiProperty({ nullable: true })
  public bio_ar!: string | null;

  @ApiProperty({ nullable: true })
  public professional_title!: string | null;

  @ApiProperty({ nullable: true })
  public professional_title_ar!: string | null;

  @ApiProperty({ type: [String] })
  public specializations!: string[];

  @ApiProperty({ type: [String] })
  public languages!: string[];

  @ApiProperty({ type: [String] })
  public skills!: string[];

  @ApiProperty({ type: [Object] })
  public education!: EducationEntry[];

  @ApiProperty({ type: [Object] })
  public certificates!: CertificateEntry[];

  /**
   * Mean approved review rating, 2 dp. `null` means the teacher has no approved
   * reviews yet — render an empty state, not zero stars.
   */
  @ApiProperty({ nullable: true, description: 'Mean approved rating; null when unrated' })
  public rating!: number | null;

  @ApiProperty({ description: 'Approved reviews backing `rating`' })
  public total_ratings!: number;

  @ApiProperty({ type: [PublicTeacherSubjectDto] })
  public subjects!: PublicTeacherSubjectDto[];

  @ApiProperty()
  public created_at!: Date;
}

/**
 * @param rating live aggregate of approved teacher reviews. Passed in rather
 *   than read from `profile.rating`, because that denormalised column was never
 *   maintained and always read 0 (DEF-007).
 */
export function toPublicTeacherResponse(
  profile: TeacherProfile,
  resolvePublicMedia: (value: string | null) => string | null,
  rating: { average: number | null; count: number },
): PublicTeacherResponseDto {
  return {
    id: profile.id,
    name: profile.user.name,
    profile_picture_url: resolvePublicMedia(profile.user.profile_picture_url),
    qualifications: profile.qualifications,
    years_of_experience: profile.years_of_experience,
    bio: profile.bio,
    bio_ar: profile.bio_ar,
    professional_title: profile.professional_title,
    professional_title_ar: profile.professional_title_ar,
    specializations: profile.specializations,
    languages: profile.languages,
    skills: profile.skills,
    education: profile.education,
    certificates: profile.certificates,
    rating: rating.average,
    total_ratings: rating.count,
    subjects: profile.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
    })),
    created_at: profile.created_at,
  };
}
