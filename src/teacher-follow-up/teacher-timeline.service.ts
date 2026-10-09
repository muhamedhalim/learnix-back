import { Injectable } from '@nestjs/common';

import type { ParentMessage } from '../notifications/entities';
import { TeacherFollowUpService } from './teacher-follow-up.service';
import type { TimelineEntry } from './teacher-follow-up.types';

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

    return entries.sort((a, b) => (a.at < b.at ? 1 : -1));
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
