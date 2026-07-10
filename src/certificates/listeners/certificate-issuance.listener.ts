import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import {
  LESSON_COMPLETED_EVENT,
  type LessonCompletedEvent,
} from '../../lessons/progress.service';
import { CertificatesService } from '../certificates.service';

/**
 * Bridges lesson completion to automatic certificate issuance. Decoupled from
 * the lessons module via the event bus so neither module depends on the other.
 */
@Injectable()
export class CertificateIssuanceListener {
  private readonly logger = new Logger(CertificateIssuanceListener.name);

  constructor(private readonly certificatesService: CertificatesService) {}

  @OnEvent(LESSON_COMPLETED_EVENT)
  public async handleLessonCompleted(event: LessonCompletedEvent): Promise<void> {
    try {
      await this.certificatesService.autoIssueForCompletedLesson(
        event.studentId,
        event.lessonId,
      );
    } catch (error) {
      this.logger.error(
        `Certificate auto-issue failed for student ${event.studentId}, lesson ${event.lessonId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
