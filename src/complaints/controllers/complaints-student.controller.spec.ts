import { ComplaintsStudentController } from './complaints-student.controller';
import { ComplaintType } from '../enums/complaint-type.enum';

describe('ComplaintsStudentController.createComplaint', () => {
  it('uses userId from the authenticated JWT payload, never a request-body student ID', async () => {
    const complaintsService = { createComplaint: jest.fn().mockResolvedValue({ id: 'complaint-id' }) };
    const controller = new ComplaintsStudentController(complaintsService as never);
    const dto = {
      type: ComplaintType.TECHNICAL,
      subject: 'Video playback',
      description: 'The video does not start.',
    };

    await expect(
      controller.createComplaint(dto, { userId: 'authenticated-student-id' } as never),
    ).resolves.toEqual({ id: 'complaint-id' });
    expect(complaintsService.createComplaint).toHaveBeenCalledWith('authenticated-student-id', dto);
  });
});
