import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Winston logger configuration for the application
 *
 * Log levels (from highest to lowest priority):
 * - error: Application errors, failed operations
 * - warn: Warnings, rate limit hits, cache misses
 * - info: User actions, purchases, registrations
 * - debug: Query times, cache operations (dev only)
 */
export const winstonConfig: WinstonModuleOptions = {
  transports: [
    // Console transport - always enabled
    new winston.transports.Console({
      level: isProduction ? 'info' : 'debug',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        isProduction
          ? winston.format.json()
          : winston.format.combine(
              winston.format.colorize({ all: true }),

              winston.format.printf((info) => {
                const ts =
                  typeof info.timestamp === 'string' ? info.timestamp : '';
                const lvl = typeof info.level === 'string' ? info.level : '';
                const msg =
                  typeof info.message === 'string' ? info.message : '';
                const ctx =
                  typeof info.context === 'string'
                    ? info.context
                    : 'Application';
                // Extract metadata excluding known fields
                const meta: Record<string, unknown> = {};
                for (const key of Object.keys(info)) {
                  if (
                    !['timestamp', 'level', 'message', 'context'].includes(key)
                  ) {
                    meta[key] = info[key];
                  }
                }
                const metaStr = Object.keys(meta).length
                  ? JSON.stringify(meta)
                  : '';
                return `${ts} [${ctx}] ${lvl}: ${msg} ${metaStr}`;
              }),
            ),
      ),
    }),

    // File transport for errors - production only
    ...(isProduction
      ? [
          new winston.transports.File({
            filename: process.env.LOG_FILE_PATH
              ? `${process.env.LOG_FILE_PATH}/error.log`
              : './logs/error.log',
            level: 'error',
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.errors({ stack: true }),
              winston.format.json(),
            ),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),

          // Combined log file
          new winston.transports.File({
            filename: process.env.LOG_FILE_PATH
              ? `${process.env.LOG_FILE_PATH}/combined.log`
              : './logs/combined.log',
            level: 'info',
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            ),
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),
        ]
      : []),
  ],

  // Handle uncaught exceptions
  exceptionHandlers: isProduction
    ? [
        new winston.transports.File({
          filename: process.env.LOG_FILE_PATH
            ? `${process.env.LOG_FILE_PATH}/exceptions.log`
            : './logs/exceptions.log',
        }),
      ]
    : [],

  // Handle unhandled promise rejections
  rejectionHandlers: isProduction
    ? [
        new winston.transports.File({
          filename: process.env.LOG_FILE_PATH
            ? `${process.env.LOG_FILE_PATH}/rejections.log`
            : './logs/rejections.log',
        }),
      ]
    : [],
};
