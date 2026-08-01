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

  function createService(studentProfile: unknown) {
    const complaintsRepository = {
      create: jest.fn().mockImplementation((input: unknown) => input),
      save: jest.fn().mockResolvedValue({ id: 'complaint-id', created_at: new Date(), ticket_number: 'CC-2026-000001' }),
      query: jest.fn().mockResolvedValue([{ value: '1' }]),
    };
    const studentProfilesRepository = { findOne: jest.fn().mockResolvedValue(studentProfile) };
    const complaintStatusPeriodsRepository = { create: jest.fn().mockImplementation((input: unknown) => input), save: jest.fn() };
    const activityLogsService = { recordAuditEvent: jest.fn() };
    const sanitizationService = { sanitizeStrict: jest.fn((value: string) => value) };
    const service = new ComplaintsService(
      complaintsRepository as never,
      {} as never,
      complaintStatusPeriodsRepository as never,
      studentProfilesRepository as never,
      {} as never,
      {} as never,
      activityLogsService as never,
      sanitizationService as never,
    );
    return { service, complaintsRepository, complaintStatusPeriodsRepository };
  }

  it('persists the complaint against the authenticated student profile user ID', async () => {
    const { service, complaintsRepository, complaintStatusPeriodsRepository } = createService({
      id: 'student-profile-id', user_id: studentUserId,
    });

    await expect(service.createComplaint(studentUserId, dto)).resolves.toMatchObject({ id: 'complaint-id' });
    expect(complaintsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      student_id: studentUserId,
      complainant_id: studentUserId,
      complainant_role: 'student',
      ticket_number: 'CC-2026-000001',
      description: dto.description,
    }));
    expect(complaintsRepository.save).toHaveBeenCalledTimes(1);
    expect(complaintStatusPeriodsRepository.save).toHaveBeenCalledTimes(1);
  });

  it('returns a business 404 without attempting an insert when the student profile is absent', async () => {
    const { service, complaintsRepository } = createService(null);

    await expect(service.createComplaint(studentUserId, dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(complaintsRepository.create).not.toHaveBeenCalled();
    expect(complaintsRepository.save).not.toHaveBeenCalled();
  });
});
