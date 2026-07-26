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

  @ApiProperty({ nullable: true })
  public name_ar!: string | null;

  @ApiProperty()
  public grade_level!: string;
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

  @ApiProperty()
  public rating!: number;

  @ApiProperty()
  public total_ratings!: number;

  @ApiProperty({ type: [PublicTeacherSubjectDto] })
  public subjects!: PublicTeacherSubjectDto[];

  @ApiProperty()
  public created_at!: Date;
}

export function toPublicTeacherResponse(
  profile: TeacherProfile,
  resolvePublicMedia: (value: string | null) => string | null,
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
    rating: profile.rating,
    total_ratings: profile.total_ratings,
    subjects: profile.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      name_ar: subject.name_ar,
      grade_level: subject.grade_level,
    })),
    created_at: profile.created_at,
  };
}
