import { StudentsService } from './students.service';

describe('StudentsService.findStudentProfile', () => {
  const userId = 'student-user-id';
  const profile = {
    id: 'student-profile-id',
    user_id: userId,
    user: {
      id: userId,
      name: 'Student Name',
      email: 'student@example.test',
      phone: '01000000000',
      profile_picture_url: null,
      status: 'approved',
      rejection_reason: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    },
    grade_level: null,
    country: null,
    governorate: null,
    school: null,
    notification_settings: {},
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };

  const chain = (rows: unknown[]) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  });

  it('keeps historical purchase and exam rows readable when their relations are soft-deleted', async () => {
    const purchasesQuery = chain([
      {
        lesson_id: 'deleted-lesson-id',
        lesson: null,
        access_granted_at: new Date('2026-01-02T00:00:00.000Z'),
        access_expires_at: new Date('2027-01-02T00:00:00.000Z'),
        price_paid: 120,
        created_at: new Date('2026-01-02T00:00:00.000Z'),
      },
    ]);
    const examsQuery = chain([
      {
        exam_id: 'deleted-exam-id',
        exam: null,
        score_total: 8,
        state: 'submitted',
        submitted_at: new Date('2026-01-03T00:00:00.000Z'),
        created_at: new Date('2026-01-03T00:00:00.000Z'),
      },
    ]);
    const studentProfiles = { findOne: jest.fn().mockResolvedValue(profile) };
    const lessonPurchases = {
      createQueryBuilder: jest.fn().mockReturnValue(purchasesQuery),
    };
    const examAttempts = {
      createQueryBuilder: jest.fn().mockReturnValue(examsQuery),
    };
    const applicationCache = {
      getOrCompute: jest.fn().mockImplementation(
        async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
      ),
    };
    const service = new StudentsService(
      studentProfiles as never,
      {} as never,
      lessonPurchases as never,
      examAttempts as never,
      applicationCache as never,
      { findPrimaryPhonesForStudents: jest.fn().mockResolvedValue(new Map()) } as never,
    );

    const result = await service.findStudentProfile(userId);

    expect(result.purchasedLessons).toEqual([
      expect.objectContaining({ lessonId: 'deleted-lesson-id', title: null }),
    ]);
    expect(result.exams).toEqual([
      expect.objectContaining({ examId: 'deleted-exam-id', title: null, totalMarks: null }),
    ]);
    expect(applicationCache.getOrCompute).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'student_profile', scope: `owner:${userId}` }),
      expect.any(Function),
    );
  });
});
