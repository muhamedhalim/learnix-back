import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { GuardianVerificationRequestedEvent } from '../../guardians/events/guardian-verification-requested.event';
import { PARENT_EVENT_CHANNEL, type ParentDomainEvent } from '../events/parent-events';
import { ParentNotificationJobsService } from '../services/parent-notification-jobs.service';

/** Mirrors `CODE_TTL_MS` in `GuardianVerificationService`. */
const OTP_TTL_MINUTES = 10;

/**
 * The single bridge between domain events and the delivery pipeline.
 *
 * It does exactly one thing: enqueue. No guardian lookup, no rendering, no
 * provider call. That is deliberate — a listener runs inside the emitting
 * request's call stack (EventEmitter2 is synchronous by default), so any work
 * done here is work added to the latency of submitting an exam. Everything
 * expensive or failure-prone belongs to the worker, where BullMQ owns retries.
 *
 * Enqueue failures are swallowed and logged: a Redis outage must never roll
 * back a student's committed exam grade.
 */
@Injectable()
export class ParentNotificationListener {
  private readonly logger = new Logger(ParentNotificationListener.name);

  constructor(private readonly jobs: ParentNotificationJobsService) {}

  @OnEvent(PARENT_EVENT_CHANNEL, { async: true })
  public async handleParentEvent(event: ParentDomainEvent): Promise<void> {
    try {
      await this.jobs.enqueueDelivery({
        eventType: event.type,
        studentId: event.studentId,
        subjectId: event.subjectId,
        variables: event.variables,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue ${event.type} for student ${event.studentId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * OTP delivery rides the same queue, as a transactional event that bypasses
   * verification gating (you cannot verify a number without first messaging it).
   * The code is carried in the job payload and never logged.
   */
  @OnEvent(GuardianVerificationRequestedEvent.NAME, { async: true })
  public async handleVerificationRequested(
    event: GuardianVerificationRequestedEvent,
  ): Promise<void> {
    try {
      await this.jobs.enqueueDelivery({
        eventType: ParentEventType.GUARDIAN_VERIFICATION,
        studentId: event.studentId,
        // One challenge per issuance: the code itself scopes the idempotency key,
        // so a resend after the previous code was burned is a distinct message.
        subjectId: `${event.guardianId}:${String(event.expiresAt.getTime())}`,
        variables: { code: event.code, ttlMinutes: OTP_TTL_MINUTES },
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue verification code for guardian ${event.guardianId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
