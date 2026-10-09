import { isInfrastructureError } from './infrastructure-error.util';

describe('isInfrastructureError', () => {
  const withCode = (code: string) => Object.assign(new Error('x'), { code });

  it.each([
    ['ECONNREFUSED', withCode('ECONNREFUSED')],
    ['ECONNRESET', withCode('ECONNRESET')],
    ['ETIMEDOUT', withCode('ETIMEDOUT')],
    ['EPIPE', withCode('EPIPE')],
    ['08006 connection failure', withCode('08006')],
    ['53300 too many connections', withCode('53300')],
    ['57P01 admin shutdown', withCode('57P01')],
    ['57P03 cannot connect now', withCode('57P03')],
    ['57014 query canceled', withCode('57014')],
    ['pool acquire timeout', new Error('timeout exceeded when trying to connect')],
    ['pool connection timeout', new Error('Connection terminated due to connection timeout')],
    ['terminated unexpectedly', new Error('Connection terminated unexpectedly')],
    [
      'wrapped driverError',
      Object.assign(new Error('Query failed'), { driverError: withCode('08006') }),
    ],
  ])('classifies %s as infrastructure', (_name, error) => {
    expect(isInfrastructureError(error)).toBe(true);
  });

  it.each([
    ['unknown Error', new Error('boom')],
    [
      '22P02 invalid text representation',
      Object.assign(new Error('x'), { driverError: { code: '22P02' } }),
    ],
    ['23505 unique violation', withCode('23505')],
    ['57P04 database dropped (not allow-listed)', withCode('57P04')],
    ['TypeError', new TypeError('undefined is not a function')],
    ['string', 'ECONNREFUSED'],
    ['null', null],
    ['undefined', undefined],
  ])('does not classify %s as infrastructure', (_name, error) => {
    expect(isInfrastructureError(error)).toBe(false);
  });
});
