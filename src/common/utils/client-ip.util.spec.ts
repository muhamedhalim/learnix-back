import type { Request } from 'express';

import { getClientIp } from './client-ip.util';

type IpRequest = Pick<Request, 'headers' | 'ip'>;

function requestWith(
  headers: Record<string, string | string[] | undefined>,
  ip?: string,
): IpRequest {
  return { headers, ip } as unknown as IpRequest;
}

describe('getClientIp', () => {
  it('returns the first hop when x-forwarded-for is present', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.1'))).toBe(
      '203.0.113.7',
    );
  });

  it('returns request.ip when x-forwarded-for is missing (AUD-001: must not throw)', () => {
    const request = requestWith({}, '10.0.0.1');
    expect(() => getClientIp(request)).not.toThrow();
    expect(getClientIp(request)).toBe('10.0.0.1');
  });

  it('returns null when neither the header nor request.ip is available', () => {
    expect(getClientIp(requestWith({}))).toBeNull();
  });

  it('takes the leftmost address from a multi-hop forwarded chain', () => {
    expect(
      getClientIp(
        requestWith({ 'x-forwarded-for': '203.0.113.7, 198.51.100.4, 10.0.0.9' }, '10.0.0.1'),
      ),
    ).toBe('203.0.113.7');
  });

  it('trims surrounding whitespace produced by proxies that join with ", "', () => {
    expect(
      getClientIp(requestWith({ 'x-forwarded-for': '  203.0.113.7 , 198.51.100.4' }, '10.0.0.1')),
    ).toBe('203.0.113.7');
  });

  it('falls back to request.ip when the header is present but empty', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': '' }, '10.0.0.1'))).toBe('10.0.0.1');
  });

  it('falls back to request.ip when the header is only whitespace', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': '   ' }, '10.0.0.1'))).toBe('10.0.0.1');
  });

  it('falls back to request.ip when the header is a bare separator', () => {
    expect(getClientIp(requestWith({ 'x-forwarded-for': ',' }, '10.0.0.1'))).toBe('10.0.0.1');
  });

  it('ignores a repeated header surfaced by Node as an array rather than trusting it', () => {
    expect(
      getClientIp(requestWith({ 'x-forwarded-for': ['203.0.113.7', '198.51.100.4'] }, '10.0.0.1')),
    ).toBe('10.0.0.1');
  });

  it('does not throw when the header is explicitly undefined', () => {
    const request = requestWith({ 'x-forwarded-for': undefined }, '10.0.0.1');
    expect(() => getClientIp(request)).not.toThrow();
    expect(getClientIp(request)).toBe('10.0.0.1');
  });
});
