import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { ParentEventType } from '../common/events/parent-event-type.enum';
import { BroadcastScope } from './dto/teacher-broadcast.dto';
import { TeacherBroadcastService } from './teacher-broadcast.service';

/**
 * T068: `preview` resolves guardians for the whole audience in one batched lookup
 * and must keep today's recipient order, reasons, sample messages and counts.
 */
describe('TeacherBroadcastService.preview', () => {
  const dto = { scope: BroadcastScope.CLASS, lessonId: 'lesson-1', message: 'Hello' } as never;

  let users: { createQueryBuilder: jest.Mock; findOneOrFail: jest.Mock };
  let userQb: { select: jest.Mock; where: jest.Mock; getMany: jest.Mock };
  let lessons: { findOne: jest.Mock };
  let lessonPurchases: { find: jest.Mock };
  let packageQb: Record<string, jest.Mock>;
  let packagePurchases: { createQueryBuilder: jest.Mock };
  let guardians: {
    findNotificationTargets: jest.Mock;
    findNotificationTargetsForStudents: jest.Mock;
  };
  let service: TeacherBroadcastService;

  const student = (id: string, name: string): { id: string; name: string } => ({ id, name });
  const target = (studentId: string): { guardian_id: string; student_id: string } => ({
    guardian_id: `g-${studentId}`,
    student_id: studentId,
  });

  beforeEach(() => {
    userQb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    users = {
      createQueryBuilder: jest.fn().mockReturnValue(userQb),
      findOneOrFail: jest.fn().mockResolvedValue({ id: 't1', name: 'Mr T' }),
    };
    lessons = { findOne: jest.fn().mockResolvedValue({ id: 'lesson-1', teacher_id: 't1' }) };
    lessonPurchases = { find: jest.fn().mockResolvedValue([]) };
    packageQb = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    packagePurchases = { createQueryBuilder: jest.fn().mockReturnValue(packageQb) };
    guardians = {
      findNotificationTargets: jest.fn(),
      findNotificationTargetsForStudents: jest.fn().mockResolvedValue(new Map()),
    };
    service = new TeacherBroadcastService(
      users as never,
      lessons as never,
      lessonPurchases as never,
      packagePurchases as never,
      {} as never,
      {} as never,
      guardians as never,
      { emit: jest.fn() } as never,
    );
  });

  it('looks up every audience member in one batched call and keeps order, reasons and counts', async () => {
    lessonPurchases.find.mockResolvedValue([
      { student_id: 's1' },
      { student_id: 's2' },
      { student_id: 's3' },
    ]);
    packageQb['getRawMany']!.mockResolvedValue([{ student_id: 's2' }, { student_id: 's4' }]);
    userQb.getMany.mockResolvedValue([
      student('s1', 'Ann'),
      student('s2', 'Bob'),
      student('s3', 'Cy'),
      student('s4', 'Di'),
    ]);
    guardians.findNotificationTargetsForStudents.mockResolvedValue(
      new Map([
        ['s1', [target('s1')]],
        ['s3', [target('s3'), target('s3')]],
      ]),
    );

    const preview = await service.preview('t1', dto);

    expect(userQb.where).toHaveBeenCalledWith('u.id = ANY(:studentIds)', {
      studentIds: ['s1', 's2', 's3', 's4'],
    });
    expect(guardians.findNotificationTargetsForStudents).toHaveBeenCalledTimes(1);
    expect(guardians.findNotificationTargetsForStudents).toHaveBeenCalledWith(
      ['s1', 's2', 's3', 's4'],
      ParentEventType.TEACHER_MESSAGE,
    );
    expect(guardians.findNotificationTargets).not.toHaveBeenCalled();
    expect(preview).toEqual({
      recipients: [
        {
          studentId: 's1',
          studentName: 'Ann',
          willReceive: true,
          sampleMessage: 'Message from Mr T about Ann:\n\nHello',
        },
        {
          studentId: 's2',
          studentName: 'Bob',
          willReceive: false,
          reason: 'No verified, opted-in guardian',
        },
        {
          studentId: 's3',
          studentName: 'Cy',
          willReceive: true,
          sampleMessage: 'Message from Mr T about Cy:\n\nHello',
        },
        {
          studentId: 's4',
          studentName: 'Di',
          willReceive: false,
          reason: 'No verified, opted-in guardian',
        },
      ],
      totalStudents: 4,
      studentsReachable: 2,
    });
  });

  it('reports an empty audience without reading users or guardians for it', async () => {
    const preview = await service.preview('t1', dto);

    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(preview).toEqual({ recipients: [], totalStudents: 0, studentsReachable: 0 });
  });

  it("refuses another teacher's lesson before any guardian or user read", async () => {
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', teacher_id: 'someone-else' });

    await expect(service.preview('t1', dto)).rejects.toBeInstanceOf(ForbiddenException);
    expect(users.createQueryBuilder).not.toHaveBeenCalled();
    expect(guardians.findNotificationTargetsForStudents).not.toHaveBeenCalled();
  });

  it('404s an unknown lesson before any guardian read', async () => {
    lessons.findOne.mockResolvedValue(null);

    await expect(service.preview('t1', dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(guardians.findNotificationTargetsForStudents).not.toHaveBeenCalled();
  });

  it('still fails when the teacher record is missing, as before', async () => {
    lessonPurchases.find.mockResolvedValue([{ student_id: 's1' }]);
    userQb.getMany.mockResolvedValue([student('s1', 'Ann')]);
    users.findOneOrFail.mockRejectedValue(new Error('EntityNotFound'));

    await expect(service.preview('t1', dto)).rejects.toThrow('EntityNotFound');
  });
});
