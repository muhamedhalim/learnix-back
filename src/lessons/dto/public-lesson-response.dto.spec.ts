import { LessonStatus } from '../entities/lesson-status.enum';
import type { LessonWithDetails } from '../lessons.service';
import { toPublicLessonResponse } from './public-lesson-response.dto';

describe('toPublicLessonResponse', () => {
  it('uses an allowlist that cannot expose paid video or storage fields', () => {
    const lesson: LessonWithDetails = {
      id: 'lesson-1',
      title: 'Algebra',
      description: 'Description',
      teacher: {
        id: 'teacher-1',
        name: 'Teacher',
        profile_picture_url: 'profiles/avatar.jpg',
      },
      subject: { id: 'subject-1', name: 'Math' },
      thumbnail: 'images/lesson.jpg',
      thumbnail_url: 'https://api.example.test/api/v1/media/public/images/lesson.jpg',
      video_asset_id: 'secret-asset-id',
      video_status: 'ready',
      video_width: 1920,
      video_height: 1080,
      video_thumbnail: 'https://provider.example/private-thumbnail.jpg',
      video_size_bytes: 1234,
      price: 100,
      duration: 60,
      is_group: false,
      is_free_preview: false,
      available_for_days: 30,
      students_count: 5,
      available_sessions_count: 2,
      next_session_at: new Date('2026-01-03T10:00:00.000Z'),
      status: LessonStatus.PUBLISHED,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
    };

    const result = toPublicLessonResponse(lesson, (value) =>
      value ? `https://api.example.test/media/${value}` : null,
    );

    expect(result).toMatchSnapshot();
    expect(JSON.stringify(result)).not.toMatch(
      /video_url|video_asset|video_status|secret-asset|private-thumbnail|"thumbnail"/i,
    );
  });
});
