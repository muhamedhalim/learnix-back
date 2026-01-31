import type { ValidationArguments, ValidationOptions } from 'class-validator';
import { registerDecorator } from 'class-validator';

export function IsSecureUrl(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: 'isSecureUrl',
      target: object.constructor,
      propertyName: propertyName.toString(),
      ...(validationOptions ? { options: validationOptions } : {}),
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') {
            return false;
          }

          try {
            const url = new URL(value);

            // Only allow HTTP/HTTPS protocols
            if (!['http:', 'https:'].includes(url.protocol)) {
              return false;
            }

            // Block localhost, private IPs, and local file access (SSRF protection)
            const hostname = url.hostname.toLowerCase();

            // Block localhost variations
            if (
              hostname === 'localhost' ||
              hostname === '127.0.0.1' ||
              hostname === '::1' ||
              hostname === '0.0.0.0'
            ) {
              return false;
            }

            // Block private IP ranges (RFC 1918)
            if (
              hostname.startsWith('10.') ||
              hostname.startsWith('192.168.') ||
              /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
            ) {
              return false;
            }

            // Block link-local addresses
            if (hostname.startsWith('169.254.')) {
              return false;
            }

            // Block IPv6 private addresses
            if (
              hostname.startsWith('fc00:') ||
              hostname.startsWith('fd00:') ||
              hostname.startsWith('fe80:')
            ) {
              return false;
            }

            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid HTTP/HTTPS URL and cannot point to private networks`;
        },
      },
    });
  };
}
