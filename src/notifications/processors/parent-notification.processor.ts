import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { DelayedError, Job, UnrecoverableError } from 'bullmq';

import {
  ParentEventType,
  TRANSACTIONAL_PARENT_EVENTS,
} from '../../common/events/parent-event-type.enum';
import { maskPhone } from '../../common/utils/mask.util';
import { FEATURE_FLAGS, isFeatureEnabled } from '../../config/feature-flags';
import { GuardiansService, type GuardianTarget } from '../../guardians/guardians.service';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { ChannelRegistryService } from '../channels/channel-registry.service';
import type {
  ChannelSendResult,
  ChannelTarget,
  ParentChannel,
} from '../channels/parent-channel.interface';
import { MessageChannel, NotificationChannel, ParentMessageStatus } from '../entities';
import { NotificationChannelPolicyService } from '../services/notification-channel-policy.service';
import { ParentMessageService } from '../services/parent-message.service';
import {
  ParentNotificationJobsService,
  type ParentDeliveryJob,
  type ParentRedeliveryJob,
} from '../services/parent-notification-jobs.service';
import { TemplateRendererService } from '../templates/template-renderer.service';

/** Variables we must never persist or log. */
const SECRET_VARIABLE_KEYS = new Set(['code']);

/**
 * The notification worker.
 *
 * Event → guardians → template → channel → delivery record. Everything that can
 * fail lives here, behind BullMQ's retry/backoff, so no domain service ever
 * waits on a provider.
 *
 * Failure policy, in order of precedence:
 *  - No eligible guardian → `UnrecoverableError`. Retrying cannot conjure a
 *    verified parent, and burning 5 attempts on every unverified student would
 *    swamp the queue.
 *  - Permanent channel error → fall through to the next channel *in this
 *    attempt* (WhatsApp → SMS). Only if every channel permanently refuses do we
 *    mark the message DEAD.
 *  - Transient error (5xx/429/timeout) → throw, let BullMQ back off and retry
 *    the same channel. Downgrading a parent to SMS because Meta had a bad
 *    minute would be a silent, permanent quality regression.
 */
@Processor(QUEUE_NAMES.PARENT_NOTIFICATIONS, { concurrency: WORKER_CONFIG.concurrency })
export class ParentNotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(ParentNotificationProcessor.name);

  constructor(
    private readonly guardians: GuardiansService,
    private readonly renderer: TemplateRendererService,
    private readonly channels: ChannelRegistryService,
    private readonly messages: ParentMessageService,
    private readonly jobs: ParentNotificationJobsService,
    private readonly channelPolicy: NotificationChannelPolicyService,
  ) {
    super();
  }

  public async process(job: Job): Promise<void> {
    // CONTACTS REAL PEOPLE. Gated at the single entry point so both the
    // first-delivery and redelivery paths are covered by one check. Enabled
    // unless ENABLE_NOTIFICATIONS is exactly "false", so production — which
    // sets nothing — is unchanged.
    //
    // Move the same job back to delayed without consuming a retry. Completing
    // it here would silently lose the message and leave nothing to replay.
    if (!isFeatureEnabled(FEATURE_FLAGS.NOTIFICATIONS)) {
      await job.moveToDelayed(Date.now() + 5 * 60_000, job.token);
      this.logger.log(`Guardian notification ${job.name} parked: ENABLE_NOTIFICATIONS=false.`);
      throw new DelayedError();
    }

    if (job.name === JOB_TYPES.PARENT.DELIVER) {
      await this.deliver(job as Job<ParentDeliveryJob>);
      return;
    }
    if (job.name === JOB_TYPES.PARENT.REDELIVER) {
      await this.redeliver(job as Job<ParentRedeliveryJob>);
      return;
    }
    this.logger.warn(`Unknown job name ${job.name}`);
  }

  private async deliver(job: Job<ParentDeliveryJob>): Promise<void> {
    const { eventType, studentId, subjectId, variables } = job.data;

    if (!this.channels.anyConfigured()) {
      throw new UnrecoverableError('No parent notification channel configured');
    }

    // EVENT ELIGIBILITY. `findNotificationTargets` is the canonical guardian
    // preference check: link exists, phone verified, not opted out, master
    // switch on, and the per-(student, guardian) `notification_preferences` key
    // for THIS event on. Nothing else in the codebase decides guardian event
    // eligibility — the four `notify_parent_on_*` columns that used to look
    // like a second opinion were removed in migration 2079000000000.
    const targets = await this.guardians.findNotificationTargets(studentId, eventType);
    if (targets.length === 0) {
      // Not an error worth retrying — the student simply has no verified,
      // opted-in guardian for this event.
      this.logger.log(`No eligible guardian for ${eventType} / student ${studentId}`);
      return;
    }

    // CHANNEL PREFERENCE, applied on top of event eligibility: a channel the
    // student switched off overrides an otherwise-eligible event.
    //
    // Transactional events are exempt. A guardian verification code is how a
    // number becomes verified in the first place, so allowing a *student* to
    // suppress it would let them permanently prevent any guardian from being
    // verified — precisely the outcome guardian verification exists to stop.
    // This mirrors the exemption `findNotificationTargets` already applies to
    // opt-out and verification gating.
    const allowedChannels = TRANSACTIONAL_PARENT_EVENTS.has(eventType)
      ? null
      : await this.resolveAllowedChannels(studentId);

    const transientFailures: string[] = [];
    let permanentFailures = 0;
    for (const target of targets) {
      try {
        await this.deliverToGuardian(
          eventType,
          subjectId,
          variables,
          target,
          job.attemptsMade + 1,
          allowedChannels,
        );
      } catch (error) {
        // Collect and rethrow after the loop so one guardian's transient
        // failure does not deprive the others of their message.
        if (error instanceof UnrecoverableError) {
          permanentFailures++;
          this.logger.warn(`Permanent guardian delivery rejection: ${error.message}`);
        } else {
          transientFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (transientFailures.length > 0) {
      throw new Error(
        `Transient delivery failure for ${String(transientFailures.length)} guardian(s): ${transientFailures[0] ?? ''}`,
      );
    }
    if (permanentFailures > 0) {
      this.logger.warn(
        `${String(permanentFailures)} guardian delivery target(s) were permanently ineligible; no retry scheduled.`,
      );
    }
  }

  /**
   * Which `MessageChannel`s the student's preferences permit for this student.
   *
   * SMS maps to `sms_enabled`. WhatsApp has no user-facing toggle and is left
   * enabled: it is a distinct transport with its own consent path (a guardian
   * opts out through `guardians.opted_out_at`), and inventing a suppression
   * rule for it here would be a business-rule change nobody asked for. What is
   * guaranteed is the stated contract — `sms_enabled = false` ⇒ no SMS.
   */
  private async resolveAllowedChannels(studentId: string): Promise<ReadonlySet<MessageChannel>> {
    const allowed = new Set<MessageChannel>([MessageChannel.WHATSAPP]);
    if (await this.channelPolicy.isAllowed(studentId, NotificationChannel.SMS)) {
      allowed.add(MessageChannel.SMS);
    }
    return allowed;
  }

  private async deliverToGuardian(
    eventType: ParentEventType,
    subjectId: string,
    variables: Record<string, unknown>,
    target: GuardianTarget,
    attempt: number,
    allowedChannels: ReadonlySet<MessageChannel> | null,
  ): Promise<void> {
    const rendered = this.renderer.render({
      eventType,
      language: target.preferred_language,
      variables,
    });

    const channelTarget: ChannelTarget = {
      guardianId: target.guardian_id,
      phoneE164: target.phone_e164,
      whatsappCapable: target.whatsapp_capable,
    };

    const configured = this.channels.resolve(channelTarget);
    const available: ParentChannel[] =
      allowedChannels === null
        ? configured
        : configured.filter((channel) => allowedChannels.has(channel.channel));

    if (available.length === 0) {
      if (configured.length > 0) {
        // A transport exists but the student switched it off. Not a delivery
        // failure and not worth a retry — the preference will still be off.
        this.logger.log(
          `Guardian ${target.guardian_id}: every available channel is disabled by ` +
            `student ${target.student_id}'s notification preferences — nothing sent`,
        );
        return;
      }
      throw new UnrecoverableError(`No channel can address guardian ${target.guardian_id}`);
    }

    // Reserve the send before touching a provider. A crash between "accepted"
    // and "markSent" leaves a QUEUED row, and the retry re-claims it — but a
    // row that already reached SENT refuses the claim, so we never double-send.
    const claim = await this.messages.claim({
      eventType,
      subjectId,
      guardianId: target.guardian_id,
      studentId: target.student_id,
      channel: available[0]?.channel ?? MessageChannel.SMS,
      templateKey: rendered.templateKey,
      body: rendered.body,
      variables: this.redact(variables),
    });

    if (!claim.claimed) {
      this.logger.debug(
        `Already delivered ${eventType}/${subjectId} to guardian ${target.guardian_id} — skipping`,
      );
      return;
    }

    let lastError = 'No channel attempted';
    for (const channel of available) {
      const result: ChannelSendResult = await channel.send(channelTarget, rendered);

      if (result.accepted) {
        await this.messages.markSent(
          claim.message.id,
          channel.channel,
          result.providerMessageId ?? null,
        );
        this.logger.log(
          `${eventType} → guardian ${target.guardian_id} ` +
            `(${maskPhone(target.phone_e164) ?? '***'}) via ${channel.channel}`,
        );
        return;
      }

      lastError = result.error ?? 'unknown error';

      // The provider told us this number is not on WhatsApp — remember it, so
      // future messages skip straight to SMS instead of paying the round trip.
      if (result.recipientNotOnChannel === true) {
        await this.guardians.markWhatsAppIncapable(target.guardian_id);
      }

      if (result.permanent !== true) {
        // Transient: record the failure and let BullMQ retry this same channel.
        await this.messages.markFailed(claim.message.id, lastError, attempt);
        throw new Error(`${channel.channel} transient failure: ${lastError}`);
      }

      // Permanent on this channel — fall through to the next one.
      this.logger.warn(
        `${channel.channel} permanently refused guardian ${target.guardian_id}: ${lastError}`,
      );
    }

    // Every channel permanently refused. Retrying is pointless.
    await this.messages.markDead(claim.message.id, lastError);
    this.logger.error(
      `All channels permanently failed for guardian ${target.guardian_id}: ${lastError}`,
    );
  }

  /** Admin-triggered replay of one stored message. */
  private async redeliver(job: Job<ParentRedeliveryJob>): Promise<void> {
    const message = await this.messages.findById(job.data.parentMessageId);
    if (!message) throw new UnrecoverableError('Parent message not found');

    if (
      message.status === ParentMessageStatus.DELIVERED ||
      message.status === ParentMessageStatus.READ
    ) {
      this.logger.log(`Message ${message.id} already ${message.status} — nothing to retry`);
      return;
    }

    // DEAD is terminal for `claim()`; a human retry must explicitly unstick it.
    if (!(await this.messages.resetForRetry(message.id))) {
      this.logger.warn(`Message ${message.id} is not in a retryable state (${message.status})`);
      return;
    }

    await this.jobs.enqueueDelivery(
      {
        eventType: message.event_type,
        studentId: message.student_id,
        subjectId: this.subjectFromKey(message.idempotency_key, message.event_type),
        variables: message.variables ?? {},
      },
      { bypassDedup: true },
    );
  }

  /** `<event>:<subject>:<guardian>` → `<subject>` (subjects may contain ':'). */
  private subjectFromKey(key: string, eventType: ParentEventType): string {
    const withoutEvent = key.slice(eventType.length + 1);
    const lastColon = withoutEvent.lastIndexOf(':');
    return lastColon === -1 ? withoutEvent : withoutEvent.slice(0, lastColon);
  }

  /** Strip OTP codes before they reach the database or the admin UI. */
  private redact(variables: Record<string, unknown>): Record<string, unknown> {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(variables)) {
      if (!SECRET_VARIABLE_KEYS.has(key)) safe[key] = value;
    }
    return safe;
  }

  /**
   * Last-chance hook: BullMQ has exhausted every attempt. Park the job on the
   * dead-letter queue so it is visible and replayable rather than trimmed away.
   */
  @OnWorkerEvent('failed')
  public async onFailed(job: Job<ParentDeliveryJob> | undefined, error: Error): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // more retries pending

    if (job.name !== JOB_TYPES.PARENT.DELIVER) return;
    await this.jobs.deadLetter(job.data, error.message);
  }
}
