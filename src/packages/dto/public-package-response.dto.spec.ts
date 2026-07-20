import { CourseStatus } from '../entities/course-status.enum';
import type { PackageWithDetails } from '../packages.service';
import { toPublicPackageResponse } from './public-package-response.dto';

describe('toPublicPackageResponse', () => {
  it('never exposes raw media keys or nested teacher account fields', () => {
    const pkg = {
      id: 'package-1',
      title: 'Course',
      title_ar: 'Course AR',
      description: null,
      description_ar: null,
      teacher: {
        id: 'teacher-1',
        name: 'Teacher',
        profile_picture_url: 'profiles/private-key.jpg',
        email: 'private@example.test',
      },
      subject: null,
      price: 100,
      original_price: 120,
      savings: 20,
      is_active: true,
      status: CourseStatus.PUBLISHED,
      featured: false,
      category: null,
      tags: null,
      estimated_duration: null,
      published_at: new Date('2026-01-01T00:00:00.000Z'),
      scheduled_publish_at: null,
      thumbnail: 'images/raw-object-key.jpg',
      thumbnail_url: 'https://api.example.test/api/v1/media/public/images/raw-object-key.jpg',
      lessons_count: 0,
      lessons: [],
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    } as PackageWithDetails;

    const result = toPublicPackageResponse(
      pkg,
      (value) => (value ? `https://api.example.test/media/${value}` : null),
    );

    expect(result).toMatchSnapshot();
    expect(JSON.stringify(result)).not.toMatch(/private@example|"images\/raw-object-key/i);
    expect(result.thumbnail).toBe(result.thumbnail_url);
  });
});
