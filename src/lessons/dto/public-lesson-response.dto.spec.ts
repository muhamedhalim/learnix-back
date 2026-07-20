import { LessonStatus } from '../entities/lesson-status.enum';
import type { LessonWithDetails } from '../lessons.service';
import { toPublicLessonResponse } from './public-lesson-response.dto';

describe('toPublicLessonResponse', () => {
  it('uses an allowlist that cannot expose paid video or storage fields', () => {
    const lesson: LessonWithDetails = {
      id: 'lesson-1',
      title: 'Algebra',
      title_ar: 'Algebra AR',
      description: 'Description',
      description_ar: null,
      teacher: {
        id: 'teacher-1',
        name: 'Teacher',
        profile_picture_url: 'profiles/avatar.jpg',
      },
      subject: { id: 'subject-1', name: 'Math', grade_level: '10' },
      thumbnail: 'images/lesson.jpg',
      thumbnail_url: 'https://api.example.test/api/v1/media/public/images/lesson.jpg',
      video_url: 'https://paid-provider.example/private-video',
      video_platform: 'bunny',
      bunny_video_id: 'secret-video-id',
      bunny_library_id: 'internal-library-id',
      bunny_video_status: 'ready',
      video_width: 1920,
      video_height: 1080,
      video_thumbnail: 'https://provider.example/private-thumbnail.jpg',
      video_size_bytes: 1234,
      vimeo_video_id: 'vimeo-secret',
      vimeo_embed_url: 'https://player.example/private',
      price: 100,
      duration: 60,
      is_group: false,
      available_for_days: 30,
      students_count: 5,
      status: LessonStatus.PUBLISHED,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };

    const result = toPublicLessonResponse(
      lesson,
      (value) => (value ? `https://api.example.test/media/${value}` : null),
    );

    expect(result).toMatchSnapshot();
    expect(JSON.stringify(result)).not.toMatch(
      /video_url|bunny_|vimeo_|secret-video|private-video|internal-library|"thumbnail"/i,
    );
  });
});
