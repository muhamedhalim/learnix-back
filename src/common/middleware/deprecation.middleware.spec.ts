import type { NextFunction, Request, Response } from 'express';

import { DeprecationMiddleware, deprecationWarning } from './deprecation.middleware';

function mockResponse(): Response {
  const headers = new Map<string, string>();
  return {
    setHeader: jest.fn((name: string, value: string) => headers.set(name, value)),
    getHeader: (name: string) => headers.get(name),
  } as unknown as Response;
}

describe('DeprecationMiddleware / deprecationWarning', () => {
  it('sets deprecation headers and a successor Link header when a successor path is given', () => {
    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    const middleware = new DeprecationMiddleware({
      version: '1.0',
      sunsetDate: '2027-02-10',
      successorPath: '/api/v1/payments/orders',
    });

    middleware.use({} as Request, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-API-Deprecated', 'true');
    expect(res.setHeader).toHaveBeenCalledWith('X-API-Sunset-Date', '2027-02-10');
    expect(res.setHeader).toHaveBeenCalledWith('X-API-Deprecated-Version', '1.0');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Link',
      '</api/v1/payments/orders>; rel="successor-version"',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('omits the Link header when no successor path is given', () => {
    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    const middleware = new DeprecationMiddleware({ version: '1.0', sunsetDate: '2027-02-10' });

    middleware.use({} as Request, res, next);

    expect(res.setHeader).not.toHaveBeenCalledWith('Link', expect.anything());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('the functional form (deprecationWarning) behaves identically to the class', () => {
    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    const handler = deprecationWarning('1.0', '2027-02-10', '/api/v1/payments/orders');

    handler({} as Request, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-API-Deprecated', 'true');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Link',
      '</api/v1/payments/orders>; rel="successor-version"',
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
