import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException, ConflictException, HttpStatus, UnprocessableEntityException } from '@nestjs/common';

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

  it('hides database details and query strings in production error responses', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const { host, captured } = buildHost();
    filter.catch(
      new Error('QueryFailedError: OFFSET must not be negative; SELECT * FROM users'),
      host,
    );
    expect(captured.body).toMatchObject({
      status: 500,
      title: 'Internal Server Error',
      detail: 'An unexpected error occurred. Please try again later.',
    });
    expect(JSON.stringify(captured.body)).not.toMatch(/PostgreSQL|TypeORM|QueryFailed|SELECT|OFFSET/i);
    if (previous === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = previous;
    }
  });
});

describe('HttpExceptionFilter — extra caller-supplied response fields', () => {
  const filter = new HttpExceptionFilter();

  it('passes through a custom field (e.g. a marketplace exception\'s `details` array) that this filter does not itself know about', () => {
    const { host, captured } = buildHost();
    filter.catch(
      new UnprocessableEntityException({
        code: 'COURSE_NOT_READY_FOR_SUBMISSION',
        message: 'This course is not ready for submission',
        details: ['at_least_one_section', 'minimum_lessons'],
      }),
      host,
    );
    expect(captured.statusCode).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(captured.body?.['details']).toEqual(['at_least_one_section', 'minimum_lessons']);
    expect(captured.body?.code).toBe('COURSE_NOT_READY_FOR_SUBMISSION');
  });

  it('passes through multiple arbitrary extra fields at once (e.g. reason + availableFrom, or courseCount)', () => {
    const { host, captured } = buildHost();
    filter.catch(
      new ConflictException({
        code: 'CATEGORY_REFERENCED',
        message: 'This category is assigned to 4 course(s) and cannot be deleted',
        courseCount: 4,
      }),
      host,
    );
    expect(captured.body?.['courseCount']).toBe(4);
  });

  it('never lets an extra field override a real RFC 7807 field (e.g. a caller cannot spoof status or requestId)', () => {
    const { host, captured } = buildHost();
    filter.catch(
      new BadRequestException({
        code: 'X',
        message: 'nope',
        status: 999,
        requestId: 'spoofed',
      }),
      host,
    );
    expect(captured.body?.['status']).toBe(HttpStatus.BAD_REQUEST);
    expect(captured.body?.['requestId']).not.toBe('spoofed');
  });
});
