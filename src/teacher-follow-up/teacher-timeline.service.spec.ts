import type { TimelineEntry, TimelineEntryType } from './teacher-follow-up.types';
import { compareTimelineEntries } from './teacher-timeline.service';

const entry = (type: TimelineEntryType, at: string, label = type): TimelineEntry => ({
  type,
  label,
  at,
});

describe('compareTimelineEntries', () => {
  it('orders newest first', () => {
    const entries = [
      entry('exam_started', '2026-01-05T09:40:00.000Z'),
      entry('exam_graded', '2026-01-06T10:00:00.000Z'),
      entry('attendance_recorded', '2026-01-05T10:00:00.000Z'),
    ];

    expect(entries.sort(compareTimelineEntries).map((e) => e.type)).toEqual([
      'exam_graded',
      'attendance_recorded',
      'exam_started',
    ]);
  });

  it('puts the later lifecycle stage first when entries share an instant', () => {
    const at = '2026-01-06T11:00:00.000Z';
    const entries = [
      entry('notification_queued', at),
      entry('notification_read', at),
      entry('notification_sent', at),
      entry('notification_delivered', at),
    ];

    expect(entries.sort(compareTimelineEntries).map((e) => e.type)).toEqual([
      'notification_read',
      'notification_delivered',
      'notification_sent',
      'notification_queued',
    ]);
  });

  it('is independent of the order the sources were read in', () => {
    const at = '2026-01-06T10:00:00.000Z';
    const entries = [
      entry('attendance_recorded', at, 'Attendance: absent — "B"'),
      entry('exam_graded', at, 'Graded "A exam"'),
      entry('attendance_recorded', at, 'Attendance: absent — "A"'),
      entry('exam_submitted', at, 'Submitted "A exam"'),
    ];
    const forward = [...entries].sort(compareTimelineEntries);
    const backward = [...entries].reverse().sort(compareTimelineEntries);

    expect(backward).toEqual(forward);
    expect(forward.map((e) => e.label)).toEqual([
      'Graded "A exam"',
      'Submitted "A exam"',
      'Attendance: absent — "A"',
      'Attendance: absent — "B"',
    ]);
  });

  it('treats identical entries as equal, so the comparator is a valid ordering', () => {
    const a = entry('exam_graded', '2026-01-06T10:00:00.000Z', 'x');
    expect(compareTimelineEntries(a, { ...a })).toBe(0);
    expect(compareTimelineEntries(a, { ...a, at: '2026-01-07T10:00:00.000Z' })).toBe(1);
    expect(compareTimelineEntries({ ...a, at: '2026-01-07T10:00:00.000Z' }, a)).toBe(-1);
  });
});
