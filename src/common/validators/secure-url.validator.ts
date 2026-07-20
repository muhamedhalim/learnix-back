import type { ValidationArguments, ValidationOptions } from 'class-validator';
import { registerDecorator } from 'class-validator';

import { isNonPublicHostname } from '../../config/public-url.util';

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

            return (
              url.username === '' &&
              url.password === '' &&
              !isNonPublicHostname(url.hostname)
            );
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
