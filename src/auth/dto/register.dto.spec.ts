import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UserRole } from '../../users/entities/user-role.enum';
import { RegisterDto } from './register.dto';

/**
 * Guards the hardened public-registration validation (SEC-11): malformed
 * emails, weak/short passwords, and empty names must be rejected by the DTO
 * before the service ever hashes or persists them.
 */
function validStudent(overrides: Partial<RegisterDto> = {}): Record<string, unknown> {
  return {
    name: 'Test Student',
    email: 'student@example.com',
    password: 'S3curePass',
    phone: '01000000000',
    requestedRole: UserRole.STUDENT,
    parentPhone: '01011111111',
    ...overrides,
  };
}

function validTeacher(overrides: Partial<RegisterDto> = {}): Record<string, unknown> {
  return {
    name: 'Test Teacher',
    email: 'teacher@example.com',
    password: 'S3curePass',
    phone: '01000000000',
    requestedRole: UserRole.TEACHER,
    qualifications: 'B.Ed in Mathematics',
    yearsOfExperience: 3,
    ...overrides,
  };
}

async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(RegisterDto, payload);
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

describe('RegisterDto validation (SEC-11 hardening)', () => {
  it('accepts a well-formed student registration', async () => {
    expect(await errorsFor(validStudent())).toEqual([]);
  });

  it('rejects a malformed email', async () => {
    expect(await errorsFor(validStudent({ email: 'not-an-email' }))).toContain('email');
  });

  it('rejects an empty email', async () => {
    expect(await errorsFor(validStudent({ email: '' }))).toContain('email');
  });

  it('rejects a password shorter than 8 characters', async () => {
    expect(await errorsFor(validStudent({ password: '123456' }))).toContain('password');
  });

  it('rejects a non-string password', async () => {
    expect(await errorsFor(validStudent({ password: 12345678 as unknown as string }))).toContain(
      'password',
    );
  });

  it('rejects a name that is too short', async () => {
    expect(await errorsFor(validStudent({ name: 'A' }))).toContain('name');
  });

  it('accepts an 8-character password (frontend-aligned minimum)', async () => {
    expect(await errorsFor(validStudent({ password: '12345678' }))).toEqual([]);
  });

  it('accepts a well-formed teacher registration', async () => {
    expect(await errorsFor(validTeacher())).toEqual([]);
  });

  it('rejects a teacher registration missing qualifications', async () => {
    const payload = validTeacher();
    delete payload['qualifications'];
    expect(await errorsFor(payload)).toContain('qualifications');
  });

  it('rejects a teacher registration with empty qualifications', async () => {
    expect(await errorsFor(validTeacher({ qualifications: '' }))).toContain('qualifications');
  });

  it('rejects a teacher registration missing yearsOfExperience', async () => {
    const payload = validTeacher();
    delete payload['yearsOfExperience'];
    expect(await errorsFor(payload)).toContain('yearsOfExperience');
  });

  it('rejects a teacher registration with a negative yearsOfExperience', async () => {
    expect(await errorsFor(validTeacher({ yearsOfExperience: -1 }))).toContain('yearsOfExperience');
  });

  it('does not require qualifications/yearsOfExperience for a student registration', async () => {
    expect(await errorsFor(validStudent())).toEqual([]);
  });
});
