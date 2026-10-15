import { Injectable } from '@nestjs/common';

import type { ParentMessage } from '../notifications/entities';
import { TeacherFollowUpService } from './teacher-follow-up.service';
import type { TimelineEntry, TimelineEntryType } from './teacher-follow-up.types';

/**
 * Position of an entry type when two entries happened at the same instant: the later lifecycle
 * stage comes first (the feed is newest-first), e.g. "Read" above "Delivered" above "Sent".
 */
const TIE_ORDER: readonly TimelineEntryType[] = [
  'notification_read',
  'notification_delivered',
  'notification_sent',
  'notification_queued',
  'homework_graded',
  'homework_submitted',
  'exam_graded',
  'exam_submitted',
  'exam_started',
  'attendance_recorded',
];

/**
 * Newest first, with a total order: entries are drawn from several independent sources and many
 * share an instant (a message is queued, sent and delivered by one provider callback; attendance
 * is marked when an exam closes). A comparator that never returns 0 made those ties depend on the
 * order the sources happened to be read in.
 */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  const byType = TIE_ORDER.indexOf(a.type) - TIE_ORDER.indexOf(b.type);
  if (byType !== 0) return byType;
  if (a.label === b.label) return 0;
  return a.label < b.label ? -1 : 1;
}

/**
 * One merged, chronological feed per student: exams, attendance, homework,
 * and guardian-notification delivery.
 *
 * Homework entries are backed by the per-student submission entity and are
 * included only after the teacher/student ownership checks above.
 */
@Injectable()
export class TeacherTimelineService {
  constructor(private readonly followUp: TeacherFollowUpService) {}

  public async getTimeline(teacherId: string, studentId: string): Promise<TimelineEntry[]> {
    await this.followUp.assertOwnsStudent(teacherId, studentId);

    const [{ attempts, attendance, messages }, homework] = await Promise.all([
      this.followUp.fetchTimelineSourcesFor(teacherId, studentId),
      this.followUp.fetchHomeworkRowsFor(teacherId, studentId),
    ]);

    const entries: TimelineEntry[] = [];

    for (const attempt of attempts) {
      entries.push({
        type: 'exam_started',
        label: `Started "${attempt.exam_name}"`,
        at: attempt.started_at.toISOString(),
      });
      if (attempt.submitted_at) {
        entries.push({
          type: 'exam_submitted',
          label: `Submitted "${attempt.exam_name}"`,
          at: attempt.submitted_at.toISOString(),
        });
      }
      if (attempt.graded_at) {
        const max = Number.parseFloat(attempt.max_score);
        const score = Number.parseFloat(attempt.score_total ?? '0');
        entries.push({
          type: 'exam_graded',
          label: `Graded "${attempt.exam_name}" — ${String(score)}/${String(max)}`,
          at: attempt.graded_at.toISOString(),
          meta: { passed: attempt.passed },
        });
      }
    }

    for (const record of attendance) {
      entries.push({
        type: 'attendance_recorded',
        label: `Attendance: ${record.status} — "${record.lesson_name}"`,
        at: record.marked_at.toISOString(),
      });
    }

    for (const submission of homework) {
      entries.push({
        type: 'homework_submitted',
        label: `Submitted "${submission.homework_title}"${submission.is_late ? ' (late)' : ''}`,
        at: submission.submitted_at.toISOString(),
      });
      if (submission.graded_at) {
        entries.push({
          type: 'homework_graded',
          label: `Graded "${submission.homework_title}" - ${String(submission.score ?? 0)}/${String(submission.max_score)}`,
          at: submission.graded_at.toISOString(),
        });
      }
    }

    for (const message of messages) {
      entries.push(...this.messageEntries(message));
    }

    return entries.sort(compareTimelineEntries);
  }

  private messageEntries(message: ParentMessage): TimelineEntry[] {
    const meta = { channel: message.channel, eventType: message.event_type };
    const entries: TimelineEntry[] = [
      {
        type: 'notification_queued',
        label: `Notification queued (${message.event_type})`,
        at: message.created_at.toISOString(),
        meta,
      },
    ];
    if (message.sent_at) {
      entries.push({
        type: 'notification_sent',
        label: 'WhatsApp/SMS sent',
        at: message.sent_at.toISOString(),
        meta,
      });
    }
    if (message.delivered_at) {
      entries.push({
        type: 'notification_delivered',
        label: 'Delivered',
        at: message.delivered_at.toISOString(),
        meta,
      });
    }
    if (message.read_at) {
      entries.push({
        type: 'notification_read',
        label: 'Read by guardian',
        at: message.read_at.toISOString(),
        meta,
      });
    }
    return entries;
  }
}
