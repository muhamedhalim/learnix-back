import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, HttpStatus } from '@nestjs/common';

import { HttpExceptionFilter } from './http-exception.filter';

interface CapturedResponse {
  statusCode?: number;
  body?: Record<string, unknown>;
}

function buildHost(): { host: ArgumentsHost; captured: CapturedResponse } {
  const captured: CapturedResponse = {};
  const response = {
    status(code: number) {
      captured.statusCode = code;
      return {
        json(payload: Record<string, unknown>) {
          captured.body = payload;
        },
      };
    },
  };
  const request = {
    method: 'POST',
    url: '/api/v1/teacher/uploads/image',
    path: '/api/v1/teacher/uploads/image',
    headers: {},
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, captured };
}

function multerError(code: string): Error {
  return Object.assign(new Error(`Multer: ${code}`), { name: 'MulterError', code });
}

describe('HttpExceptionFilter — Multer upload errors (SEC-06)', () => {
  const filter = new HttpExceptionFilter();

  it('maps LIMIT_FILE_SIZE to 413 Payload Too Large (not a raw 500)', () => {
    const { host, captured } = buildHost();
    filter.catch(multerError('LIMIT_FILE_SIZE'), host);
    expect(captured.statusCode).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    expect(captured.body?.code).toBe('LIMIT_FILE_SIZE');
  });

  it('maps other Multer errors to 400 Bad Request', () => {
    const { host, captured } = buildHost();
    filter.catch(multerError('LIMIT_UNEXPECTED_FILE'), host);
    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body?.code).toBe('LIMIT_UNEXPECTED_FILE');
  });

  it('still honours explicit HttpExceptions', () => {
    const { host, captured } = buildHost();
    filter.catch(new BadRequestException('nope'), host);
    expect(captured.statusCode).toBe(HttpStatus.BAD_REQUEST);
  });

  it('maps an unknown error to 500', () => {
    const { host, captured } = buildHost();
    filter.catch(new Error('boom'), host);
    expect(captured.statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  });
});
