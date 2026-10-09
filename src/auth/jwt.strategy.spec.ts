import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy.validate', () => {
  const payload = { sub: 'u1', email: 'a@b.c', sid: 's1' };
  const build = (validateUser: jest.Mock) =>
    new JwtStrategy({ get: () => 'x'.repeat(40) } as never, { validateUser } as never);

  it('returns the principal when validateUser resolves one', async () => {
    const principal = { userId: 'u1' };
    await expect(build(jest.fn().mockResolvedValue(principal)).validate(payload)).resolves.toBe(
      principal,
    );
  });

  it('pg connection error -> ServiceUnavailableException', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    await expect(
      build(jest.fn().mockRejectedValue(error)).validate(payload),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('pool acquire timeout -> ServiceUnavailableException', async () => {
    const error = new Error('timeout exceeded when trying to connect');
    await expect(
      build(jest.fn().mockRejectedValue(error)).validate(payload),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('QueryFailedError 22P02 -> original error rethrown (500 as today)', async () => {
    const error = Object.assign(new Error('invalid input'), { driverError: { code: '22P02' } });
    await expect(build(jest.fn().mockRejectedValue(error)).validate(payload)).rejects.toBe(error);
  });

  it('unknown Error -> original error rethrown', async () => {
    const error = new Error('boom');
    await expect(build(jest.fn().mockRejectedValue(error)).validate(payload)).rejects.toBe(error);
  });

  it('validateUser null -> UnauthorizedException', async () => {
    await expect(build(jest.fn().mockResolvedValue(null)).validate(payload)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
