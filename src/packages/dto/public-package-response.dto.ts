import type { PackageWithDetails } from '../packages.service';

export interface PublicPackageResponseDto {
  id: string;
  title: string;
  title_ar: string;
  description: string | null;
  description_ar: string | null;
  teacher: PackageWithDetails['teacher'];
  subject: PackageWithDetails['subject'];
  price: number;
  original_price: number | null;
  savings: number | null;
  featured: boolean;
  category: string | null;
  tags: string[] | null;
  estimated_duration: number | null;
  published_at: Date | null;
  thumbnail: string | null;
  thumbnail_url: string | null;
  lessons_count: number;
  lessons: PackageWithDetails['lessons'];
  created_at: Date;
  updated_at: Date;
}

/** Explicit public package allowlist; raw media/storage references are absent. */
export function toPublicPackageResponse(
  pkg: PackageWithDetails,
  resolvePublicMedia: (value: string | null) => string | null,
): PublicPackageResponseDto {
  const thumbnailUrl = pkg.thumbnail_url;
  return {
    id: pkg.id,
    title: pkg.title,
    title_ar: pkg.title_ar,
    description: pkg.description,
    description_ar: pkg.description_ar,
    teacher: pkg.teacher
      ? {
          id: pkg.teacher.id,
          name: pkg.teacher.name,
          profile_picture_url: resolvePublicMedia(pkg.teacher.profile_picture_url),
        }
      : null,
    subject: pkg.subject,
    price: pkg.price,
    original_price: pkg.original_price,
    savings: pkg.savings,
    featured: pkg.featured,
    category: pkg.category,
    tags: pkg.tags,
    estimated_duration: pkg.estimated_duration,
    published_at: pkg.published_at,
    // Retain the historical `thumbnail` field without exposing the stored key.
    thumbnail: thumbnailUrl,
    thumbnail_url: thumbnailUrl,
    lessons_count: pkg.lessons_count,
    lessons: pkg.lessons,
    created_at: pkg.created_at,
    updated_at: pkg.updated_at,
  };
}
