import { HttpException, Logger } from '@nestjs/common';

export interface ParsedError {
  message: string;
  code?: string;
}

export function parseError(error: unknown): ParsedError {
  if(error instanceof Error) {
    return {
      message: error.message,
      code: 'code' in error ? String(error.code) : undefined,
    };
  }
  return { message: String(error) };
}

export function logAndThrow(
  logger: Logger,
  error: unknown,
  context: string,
  httpException: HttpException,
): never {
  const { message, code } = parseError(error);
  const logMessage = code
    ? `${context}: ${message} (code: ${code})`
    : `${context}: ${message}`;
  logger.error(logMessage);
  throw httpException;
}
