import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { AttendanceCodeFilterDto } from '../../attendance-codes/dto/attendance-code-filter.dto';
import { ComplaintFilterDto } from '../../complaints/dto/complaint-filter.dto';
import { DiscountFilterDto } from '../../discount-codes/dto/discount-filter.dto';
import { LessonFilterDto } from '../../lessons/dto/lesson-filter.dto';
import {
  AdminNotificationFilterDto,
  NotificationFilterDto,
} from '../../notifications/dto/notification-filter.dto';
import { StrictBooleanQuery } from './strict-boolean-query.decorator';

/**
 * The global `ValidationPipe` in `main.ts` runs with
 * `transformOptions: { enableImplicitConversion: true }`, so every test here
 * transforms with that flag on. That is the whole point: the previous
 * `@Transform(({ value }) => value === 'true' || value === true)` looked
 * correct in isolation and was wrong under the pipe the application actually
 * uses, because implicit conversion had already turned `'false'` into `true`.
 */
const PIPE_OPTIONS = { enableImplicitConversion: true } as const;

class Probe {
  @StrictBooleanQuery()
  public flag?: boolean;
}

function parse<T extends object>(cls: new () => T, payload: Record<string, unknown>): T {
  return plainToInstance(cls, payload, PIPE_OPTIONS);
}

describe('StrictBooleanQuery', () => {
  describe('parsing', () => {
    it.each([
      ['true', true],
      ['false', false],
      ['1', true],
      ['0', false],
      ['TRUE', true],
      ['False', false],
      ['  true  ', true],
      ['  false  ', false],
    ])('parses %j as %s under implicit conversion', (raw, expected) => {
      expect(parse(Probe, { flag: raw }).flag).toBe(expected);
    });

    it('passes real booleans through untouched', () => {
      expect(parse(Probe, { flag: true }).flag).toBe(true);
      expect(parse(Probe, { flag: false }).flag).toBe(false);
    });

    it('leaves an absent parameter undefined so no filter is applied', () => {
      expect(parse(Probe, {}).flag).toBeUndefined();
    });

    it('treats an empty value as absent rather than false', () => {
      expect(parse(Probe, { flag: '' }).flag).toBeUndefined();
    });

    it('rejects unparseable input instead of silently guessing', () => {
      const parsed = parse(Probe, { flag: 'maybe' });
      expect(parsed.flag).not.toBe(true);
      expect(validateSync(parsed)).toHaveLength(1);
    });

    it('rejects a repeated parameter delivered as an array', () => {
      const parsed = parse(Probe, { flag: ['true', 'false'] });
      expect(validateSync(parsed)).toHaveLength(1);
    });

    it('accepts a valid value without validation errors', () => {
      expect(validateSync(parse(Probe, { flag: 'false' }))).toHaveLength(0);
    });
  });

  /**
   * Every filter that carried the broken transform. Each `false` case returned
   * the exact opposite of what the caller asked for; `GET /lessons?is_group=false`
   * — the public one-to-one shop surface — served group lessons.
   */
  describe('the filters that were affected', () => {
    it.each([
      ['LessonFilterDto.is_group', LessonFilterDto, 'is_group'],
      ['LessonFilterDto.has_available_sessions', LessonFilterDto, 'has_available_sessions'],
      ['AttendanceCodeFilterDto.is_used', AttendanceCodeFilterDto, 'is_used'],
      ['AttendanceCodeFilterDto.include_expired', AttendanceCodeFilterDto, 'include_expired'],
      ['ComplaintFilterDto.unassigned', ComplaintFilterDto, 'unassigned'],
      ['ComplaintFilterDto.overdue', ComplaintFilterDto, 'overdue'],
      ['DiscountFilterDto.is_active', DiscountFilterDto, 'is_active'],
      ['DiscountFilterDto.include_expired', DiscountFilterDto, 'include_expired'],
      ['NotificationFilterDto.is_read', NotificationFilterDto, 'is_read'],
      ['NotificationFilterDto.sms_sent', NotificationFilterDto, 'sms_sent'],
      ['AdminNotificationFilterDto.needs_attention', AdminNotificationFilterDto, 'needs_attention'],
    ])('%s honours ?field=false', (_label, cls, field) => {
      const parsed = parse(cls as never, { [field]: 'false' }) as Record<string, unknown>;
      expect(parsed[field]).toBe(false);
    });

    it.each([
      ['LessonFilterDto.is_group', LessonFilterDto, 'is_group'],
      ['AttendanceCodeFilterDto.is_used', AttendanceCodeFilterDto, 'is_used'],
      ['ComplaintFilterDto.unassigned', ComplaintFilterDto, 'unassigned'],
      ['DiscountFilterDto.is_active', DiscountFilterDto, 'is_active'],
      ['NotificationFilterDto.is_read', NotificationFilterDto, 'is_read'],
    ])('%s still honours ?field=true', (_label, cls, field) => {
      const parsed = parse(cls as never, { [field]: 'true' }) as Record<string, unknown>;
      expect(parsed[field]).toBe(true);
    });

    it('leaves lesson filters undefined when the caller sends neither flag', () => {
      const parsed = parse(LessonFilterDto, {});
      expect(parsed.is_group).toBeUndefined();
      expect(parsed.has_available_sessions).toBeUndefined();
    });
  });
});
