import { Subject } from '../../subjects/entities/subject.entity';
import { User } from '../../users/entities/user.entity';
import { Book } from '../entities/book.entity';
import { toPublicBookResponse } from './public-book-response.dto';

describe('public book serialization', () => {
  it('never exposes the paid object key or nested teacher account data', () => {
    const teacher = Object.assign(new User(), {
      id: 'teacher-id',
      name: 'Teacher',
      email: 'private@example.com',
      phone: '+201000000000',
      profile_picture_url: 'profiles/avatar.jpg',
    });
    const subject = Object.assign(new Subject(), {
      id: 'subject-id',
      name: 'Math',
      name_ar: null,
      grade_level: '10',
    });
    const book = Object.assign(new Book(), {
      id: 'book-id',
      title: 'Book',
      title_ar: 'Book AR',
      description: null,
      description_ar: null,
      teacher_id: teacher.id,
      teacher,
      subject_id: subject.id,
      subject,
      cover_image: 'images/cover.jpg',
      book_file: 'books/private-paid-object.pdf',
      price: 20,
      purchase_count: 3,
      created_at: new Date('2026-01-01T00:00:00Z'),
    });

    const result = toPublicBookResponse(book, (value) =>
      value ? `https://api.example.com/api/v1/media/public/${value}` : null,
    );
    expect(result).toMatchSnapshot();
    expect(JSON.stringify(result)).not.toMatch(/book_file|private-paid-object|private@example|phone/i);
  });
});
