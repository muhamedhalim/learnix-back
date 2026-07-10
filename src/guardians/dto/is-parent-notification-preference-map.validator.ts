import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

import { ParentEventType } from '../../common/events/parent-event-type.enum';

const KNOWN_EVENTS = new Set<string>(Object.values(ParentEventType));

/**
 * Guards the `student_guardians.notification_preferences` jsonb column.
 *
 * `@IsObject()` alone would let a client persist arbitrary JSON into the
 * column — unbounded keys, nested objects, whatever. Preferences are a closed
 * map from a known event type to a boolean, so validate exactly that.
 *
 * `GUARDIAN_VERIFICATION` is rejected too: OTP delivery is transactional and
 * must not be opt-out-able, so accepting a preference for it would be a lie.
 */
export function IsParentNotificationPreferenceMap(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isParentNotificationPreferenceMap',
      target: object.constructor,
      propertyName,
      // `exactOptionalPropertyTypes` forbids passing an explicit `undefined`.
      ...(options === undefined ? {} : { options }),
      validator: {
        validate(value: unknown): boolean {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

          return Object.entries(value).every(
            ([key, entry]) =>
              KNOWN_EVENTS.has(key) &&
              key !== ParentEventType.GUARDIAN_VERIFICATION &&
              typeof entry === 'boolean',
          );
        },
        defaultMessage(args: ValidationArguments): string {
          const allowed = [...KNOWN_EVENTS]
            .filter((event) => event !== ParentEventType.GUARDIAN_VERIFICATION)
            .join(', ');
          return `${args.property} must map known event types to booleans. Allowed keys: ${allowed}`;
        },
      },
    });
  };
}
