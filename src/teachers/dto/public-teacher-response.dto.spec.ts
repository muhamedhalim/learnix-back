import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { TeacherProfile } from '../entities/teacher-profile.entity';
import { toPublicTeacherResponse } from './public-teacher-response.dto';

describe('public teacher serialization', () => {
  it('allowlists professional fields and excludes every private account field', () => {
    const user = Object.assign(new User(), {
      id: 'user-id',
      name: 'Teacher Name',
      email: 'private@example.com',
      phone: '+201000000000',
      username: 'private-login',
      password_hash: 'hash',
      firebase_uid: 'firebase-id',
      status: 'approved',
      rejection_reason: 'private note',
      profile_picture_url: 'profiles/avatar.jpg',
    });
    const subject = Object.assign(new Subject(), {
      id: 'subject-id',
      name: 'Math',
      deleted_at: new Date(),
    });
    const profile = Object.assign(new TeacherProfile(), {
      id: 'profile-id',
      user,
      qualifications: 'MSc',
      years_of_experience: 5,
      bio: 'Bio',
      bio_ar: null,
      professional_title: 'Instructor',
      professional_title_ar: null,
      specializations: ['Algebra'],
      languages: ['en'],
      skills: ['Teaching'],
      education: [],
      certificates: [],
      rating: 4.8,
      total_ratings: 12,
      subjects: [subject],
      created_at: new Date('2026-01-01T00:00:00Z'),
    });

    const result = toPublicTeacherResponse(
      profile,
      (value) => (value ? `https://api.example.com/api/v1/media/public/${value}` : null),
      // Ratings are supplied by the caller from approved reviews; the legacy
      // `profile.rating` column above is deliberately ignored (DEF-007).
      { average: 4.8, count: 12 },
    );
    expect(result).toMatchSnapshot();
    expect(result).toMatchObject({
      name: 'Teacher Name',
      profile_picture_url: 'https://api.example.com/api/v1/media/public/profiles/avatar.jpg',
    });
    expect(result).not.toHaveProperty('user');
    expect(JSON.stringify(result)).not.toMatch(
      /private@example|phone|username|password|firebase|status|rejection|deleted_at/i,
    );
  });
});
