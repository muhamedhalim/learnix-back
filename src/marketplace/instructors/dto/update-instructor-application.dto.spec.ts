import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { UpdateInstructorApplicationDto } from './update-instructor-application.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

async function body<T extends object>(metatype: new () => T, value: object): Promise<T> {
  return pipe.transform(value, { type: 'body', metatype });
}

describe('UpdateInstructorApplicationDto (T041)', () => {
  it('accepts a completely empty body — no field is mandatory at the DTO level (the service enforces FR-011 at submission)', async () => {
    await expect(body(UpdateInstructorApplicationDto, {})).resolves.toBeDefined();
  });

  it('accepts a partial update touching only one field', async () => {
    const result = await body(UpdateInstructorApplicationDto, { display_name: 'Nour' });
    expect(result.display_name).toBe('Nour');
  });

  it('refuses a non-secure professional link URL', async () => {
    await expect(
      body(UpdateInstructorApplicationDto, {
        professional_links: [{ kind: 'linkedin', url: 'javascript:alert(1)' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a professional link pointing at a private network host', async () => {
    await expect(
      body(UpdateInstructorApplicationDto, {
        professional_links: [{ kind: 'website', url: 'http://127.0.0.1/evil' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unknown professional link kind', async () => {
    await expect(
      body(UpdateInstructorApplicationDto, {
        professional_links: [{ kind: 'facebook', url: 'https://facebook.com/x' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid professional link', async () => {
    const result = await body(UpdateInstructorApplicationDto, {
      professional_links: [{ kind: 'linkedin', url: 'https://linkedin.com/in/example' }],
    });
    expect(result.professional_links).toHaveLength(1);
  });

  it('refuses more than 10 professional links', async () => {
    const links = Array.from({ length: 11 }, (_, i) => ({
      kind: 'website',
      url: `https://example.com/${i}`,
    }));
    await expect(body(UpdateInstructorApplicationDto, { professional_links: links })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses negative years of experience', async () => {
    await expect(body(UpdateInstructorApplicationDto, { years_of_experience: -1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts zero years of experience', async () => {
    const result = await body(UpdateInstructorApplicationDto, { years_of_experience: 0 });
    expect(result.years_of_experience).toBe(0);
  });

  it('refuses an education entry with an out-of-range start_year', async () => {
    await expect(
      body(UpdateInstructorApplicationDto, {
        education: [{ institution: 'X', degree: 'Y', field: 'Z', start_year: 1800 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a well-formed education entry with no end_year', async () => {
    const result = await body(UpdateInstructorApplicationDto, {
      education: [{ institution: 'Cairo University', degree: 'BSc', field: 'Computer Science', start_year: 2015 }],
    });
    expect(result.education).toHaveLength(1);
  });

  it('refuses a non-UUID intended category id', async () => {
    await expect(
      body(UpdateInstructorApplicationDto, { intended_category_ids: ['not-a-uuid'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an unrecognized field (whitelist)', async () => {
    await expect(
      body(UpdateInstructorApplicationDto, { role: 'admin' } as unknown as object),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
