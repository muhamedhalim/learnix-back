import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ComplaintType } from '../enums/complaint-type.enum';
import { CreateComplaintDto } from './create-complaint.dto';

async function errorsFor(description: unknown): Promise<string[]> {
  const dto = plainToInstance(CreateComplaintDto, {
    type: ComplaintType.TECHNICAL,
    subject: 'Video playback',
    description,
  });
  return (await validate(dto)).map((error) => error.property);
}

describe('CreateComplaintDto validation', () => {
  it('accepts a non-empty description of at least eight trimmed characters', async () => {
    expect(await errorsFor('  The video will not start.  ')).toEqual([]);
  });

  it('rejects descriptions shorter than eight characters', async () => {
    expect(await errorsFor('Short')).toContain('description');
  });

  it('rejects whitespace-only descriptions after trimming', async () => {
    expect(await errorsFor('        ')).toContain('description');
  });
});
