import { NotFoundException } from '@nestjs/common';

import { ComplaintType } from './enums/complaint-type.enum';
import { ComplaintsService } from './complaints.service';

describe('ComplaintsService.createComplaint', () => {
  const studentUserId = 'student-user-id';
  const dto = {
    type: ComplaintType.TECHNICAL,
    subject: 'Video playback',
    description: 'The video does not start.',
  };

  it('persists the complaint against the authenticated student profile user ID', async () => {
    const complaint = { id: 'complaint-id' };
    const complaintsRepository = {
      create: jest.fn().mockImplementation((input: unknown) => input),
      save: jest.fn().mockResolvedValue(complaint),
    };
    const studentProfilesRepository = {
      findOne: jest.fn().mockResolvedValue({ id: 'student-profile-id', user_id: studentUserId }),
    };
    const service = new ComplaintsService(
      complaintsRepository as never,
      studentProfilesRepository as never,
      {} as never,
    );

    await expect(service.createComplaint(studentUserId, dto)).resolves.toEqual(complaint);
    expect(complaintsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ student_id: studentUserId, description: dto.description }),
    );
    expect(complaintsRepository.save).toHaveBeenCalledTimes(1);
  });

  it('returns a business 404 without attempting an insert when the student profile is absent', async () => {
    const complaintsRepository = { create: jest.fn(), save: jest.fn() };
    const studentProfilesRepository = { findOne: jest.fn().mockResolvedValue(null) };
    const service = new ComplaintsService(
      complaintsRepository as never,
      studentProfilesRepository as never,
      {} as never,
    );

    await expect(service.createComplaint(studentUserId, dto)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(complaintsRepository.create).not.toHaveBeenCalled();
    expect(complaintsRepository.save).not.toHaveBeenCalled();
  });
});
