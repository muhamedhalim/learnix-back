import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { PackagesService } from './packages.service';

/**
 * Each teacher-facing package endpoint words its own 403, and every one answers 404 for an absent
 * package. `findOwnedPackage` replaced seven copies of that check; this pins the per-endpoint text
 * so the shared helper can never flatten the messages the API returns today.
 */
describe('PackagesService per-endpoint ownership responses', () => {
  const packagesRepository = { findOne: jest.fn(), softDelete: jest.fn(), save: jest.fn() };
  const service = Object.assign(Object.create(PackagesService.prototype) as PackagesService, {
    packagesRepository,
  });

  beforeEach(() => jest.clearAllMocks());

  const forbiddenMessage = async (action: () => Promise<unknown>): Promise<string> => {
    const error = (await action().catch((e: unknown) => e)) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    return JSON.stringify(error.getResponse());
  };

  it.each([
    ['delete', () => service.delete('p1', 'teacher-1'), 'delete your own packages'],
    [
      'toggleActive',
      () => service.toggleActive('p1', 'teacher-1', true),
      'modify your own packages',
    ],
    [
      'findOneForTeacher',
      () => service.findOneForTeacher('p1', 'teacher-1'),
      'access your own packages',
    ],
  ])(
    "%s answers 403 with its own wording for another teacher's package",
    async (_n, call, text) => {
      packagesRepository.findOne.mockResolvedValue({ id: 'p1', teacher_id: 'someone-else' });

      expect(await forbiddenMessage(call)).toContain(text);
    },
  );

  it.each([
    ['delete', () => service.delete('p1', 'teacher-1')],
    ['toggleActive', () => service.toggleActive('p1', 'teacher-1', true)],
    ['findOneForTeacher', () => service.findOneForTeacher('p1', 'teacher-1')],
  ])('%s answers 404 for an absent package', async (_n, call) => {
    packagesRepository.findOne.mockResolvedValue(null);

    await expect(call()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findOneForTeacher only loads the id and owner columns for the check', async () => {
    packagesRepository.findOne.mockResolvedValue({ id: 'p1', teacher_id: 'someone-else' });
    await service.findOneForTeacher('p1', 'teacher-1').catch(() => undefined);

    expect(packagesRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, teacher_id: true } }),
    );
  });
});
