import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreatePackageDto } from './create-package.dto';

/**
 * Regression coverage: subject_id must be required and validated as a UUID
 * at the DTO layer, so an invalid/missing subject never reaches the service
 * or the database (see POST /teacher/packages 500 root cause).
 */
describe('CreatePackageDto', () => {
  it('is valid when subject_id is a UUID alongside the other required fields', async () => {
    const dto = plainToInstance(CreatePackageDto, {
      title: 'Algebra Basics',
      subject_id: '11111111-1111-4111-8111-111111111111',
      price: 100,
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('rejects a request with no subject_id at all', async () => {
    const dto = plainToInstance(CreatePackageDto, {
      title: 'Algebra Basics',
      price: 100,
    });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'subject_id')).toBe(true);
  });

  it('rejects a subject_id that is not a valid UUID', async () => {
    const dto = plainToInstance(CreatePackageDto, {
      title: 'Algebra Basics',
      subject_id: 'not-a-uuid',
      price: 100,
    });

    const errors = await validate(dto);

    expect(errors.some((e) => e.property === 'subject_id')).toBe(true);
  });
});
