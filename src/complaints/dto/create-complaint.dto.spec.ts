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

  it('rejects a whitespace-only subject after trimming', async () => {
    const dto = plainToInstance(CreateComplaintDto, {
      type: ComplaintType.TECHNICAL,
      subject: '   ',
      description: 'A sufficiently long description.',
    });

    expect((await validate(dto)).map((error) => error.property)).toContain('subject');
  });

  it('accepts a UUID request id and rejects an invalid one', async () => {
    const valid = plainToInstance(CreateComplaintDto, {
      type: ComplaintType.TECHNICAL,
      subject: 'Playback',
      description: 'A sufficiently long description.',
      request_id: 'cab20a31-e930-43b4-8561-1b4cbd42281c',
    });
    const invalid = plainToInstance(CreateComplaintDto, {
      type: ComplaintType.TECHNICAL,
      subject: 'Playback',
      description: 'A sufficiently long description.',
      request_id: 'retry-me',
    });

    expect(await validate(valid)).toHaveLength(0);
    expect((await validate(invalid)).map((error) => error.property)).toContain('request_id');
  });
});
