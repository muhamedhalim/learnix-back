import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ComplaintStatus } from '../enums/complaint-status.enum';
import { TransitionComplaintDto } from './transition-complaint.dto';

describe('TransitionComplaintDto validation', () => {
  it('requires a resolution summary when resolving a ticket', async () => {
    const dto = plainToInstance(TransitionComplaintDto, {
      status: ComplaintStatus.RESOLVED,
      version: 1,
      resolution: '   ',
    });

    expect((await validate(dto)).map((error) => error.property)).toContain('resolution');
  });

  it('requires a reason for close, reopen and escalation', async () => {
    for (const status of [
      ComplaintStatus.CLOSED,
      ComplaintStatus.REOPENED,
      ComplaintStatus.ESCALATED,
    ]) {
      const dto = plainToInstance(TransitionComplaintDto, { status, version: 1 });
      expect((await validate(dto)).map((error) => error.property)).toContain('reason');
    }
  });

  it('accepts an ordinary in-progress transition without resolution or reason', async () => {
    const dto = plainToInstance(TransitionComplaintDto, {
      status: ComplaintStatus.IN_PROGRESS,
      version: 2,
    });

    expect(await validate(dto)).toHaveLength(0);
  });
});
