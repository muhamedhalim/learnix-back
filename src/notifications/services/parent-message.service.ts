import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { ParentEventType } from '../../common/events/parent-event-type.enum';
import {
  MessageChannel,
  ParentMessage,
  ParentMessageStatus,
} from '../entities';

/** The subset of statuses a provider webhook is allowed to report. */
export type ProviderStatus =
  | ParentMessageStatus.SENT
  | ParentMessageStatus.DELIVERED
  | ParentMessageStatus.READ
  | ParentMessageStatus.FAILED;

/** Terminal states — a message here is never re-sent. */
const TERMINAL: ReadonlySet<ParentMessageStatus> = new Set([
  ParentMessageStatus.SENT,
  ParentMessageStatus.DELIVERED,
  ParentMessageStatus.READ,
  ParentMessageStatus.DEAD,
]);

export interface ClaimInput {
  eventType: ParentEventType;
  subjectId: string;
  guardianId: string;
  studentId: string;
  channel: MessageChannel;
  templateKey: string;
  body: string;
  variables: Record<string, unknown> | null;
}

export interface ClaimResult {
  /** False when another worker (or an earlier attempt) already owns this send. */
  claimed: boolean;
  message: ParentMessage;
}

@Injectable()
export class ParentMessageService {
  private readonly logger = new Logger(ParentMessageService.name);

  constructor(
    @InjectRepository(ParentMessage)
    private readonly messages: Repository<ParentMessage>,
  ) {}

  /**
   * `<event>:<subject>:<guardian>` — stable across retries and workers.
   *
   * The subject is the *thing that happened* (an attempt id, an attendance
   * record id), never a timestamp. That is what makes re-grading an attempt or
   * re-marking attendance a no-op rather than a second message to the parent.
   */
  public static idempotencyKey(
    eventType: ParentEventType,
    subjectId: string,
    guardianId: string,
  ): string {
    return `${eventType}:${subjectId}:${guardianId}`;
  }

  /**
   * Reserve the right to send, atomically.
   *
   * Inserts the row *before* any provider call. Postgres' UNIQUE index on
   * `idempotency_key` is the arbiter: `ON CONFLICT DO NOTHING` means exactly one
   * caller inserts, and everyone else reads back the existing row. If that row
   * is already terminal we refuse the claim, so a BullMQ retry of a job that
   * crashed *after* the provider accepted cannot double-send.
   */
  public async claim(input: ClaimInput): Promise<ClaimResult> {
    const key = ParentMessageService.idempotencyKey(
      input.eventType,
      input.subjectId,
      input.guardianId,
    );

    // Typed as the entity, then widened once. `QueryDeepPartialEntity` recurses
    // into the `variables` jsonb column's `Record<string, unknown>`, which under
    // `exactOptionalPropertyTypes` no longer accepts a plain record. Annotating
    // as `Partial<ParentMessage>` keeps every column name and type checked; the
    // single cast at the call site only relaxes TypeORM's deep-partial wrapper.
    const values: Partial<ParentMessage> = {
      idempotency_key: key,
      guardian_id: input.guardianId,
      student_id: input.studentId,
      event_type: input.eventType,
      channel: input.channel,
      status: ParentMessageStatus.QUEUED,
      template_key: input.templateKey,
      body: input.body,
      variables: input.variables,
    };

    const insert = await this.messages
      .createQueryBuilder()
      .insert()
      .into(ParentMessage)
      .values(values as QueryDeepPartialEntity<ParentMessage>)
      .orIgnore()
      .returning('*')
      .execute();

    const inserted = (insert.raw as ParentMessage[])[0];
    if (inserted !== undefined) return { claimed: true, message: inserted };

    // Conflict: someone else already created it.
    const existing = await this.messages.findOneOrFail({ where: { idempotency_key: key } });

    if (TERMINAL.has(existing.status)) {
      this.logger.debug(`Skipping ${key} — already ${existing.status}`);
      return { claimed: false, message: existing };
    }

    // QUEUED or FAILED → this attempt may proceed.
    return { claimed: true, message: existing };
  }

  public async markSent(
    id: string,
    channel: MessageChannel,
    providerMessageId: string | null,
  ): Promise<void> {
    await this.messages.update(id, {
      status: ParentMessageStatus.SENT,
      channel,
      provider_message_id: providerMessageId,
      sent_at: new Date(),
      error_message: null,
    });
  }

  public async markFailed(id: string, reason: string, attempts: number): Promise<void> {
    await this.messages.update(id, {
      status: ParentMessageStatus.FAILED,
      error_message: reason.slice(0, 1000),
      attempts,
      failed_at: new Date(),
    });
  }

  /** Every retry exhausted, or a permanent failure on every channel. */
  public async markDead(id: string, reason: string): Promise<void> {
    await this.messages.update(id, {
      status: ParentMessageStatus.DEAD,
      error_message: reason.slice(0, 1000),
      failed_at: new Date(),
    });
  }

  /**
   * Promote a message on a provider delivery/read webhook.
   *
   * Monotonic: `sent → delivered → read`. A late-arriving `sent` callback can
   * never demote a row that already reached `read`, which webhooks (delivered
   * out of order, at-least-once) otherwise would.
   */
  public async applyProviderStatus(
    providerMessageId: string,
    status: ProviderStatus,
    at: Date,
    error?: string,
  ): Promise<boolean> {
    const message = await this.messages.findOne({
      where: { provider_message_id: providerMessageId },
    });
    if (!message) return false;

    const rank: Record<string, number> = {
      [ParentMessageStatus.QUEUED]: 0,
      [ParentMessageStatus.FAILED]: 0,
      [ParentMessageStatus.SENT]: 1,
      [ParentMessageStatus.DELIVERED]: 2,
      [ParentMessageStatus.READ]: 3,
      [ParentMessageStatus.DEAD]: 3,
    };

    if (status !== ParentMessageStatus.FAILED && (rank[status] ?? 0) <= (rank[message.status] ?? 0)) {
      return false; // out-of-order or duplicate webhook
    }

    // Built explicitly rather than mutated: `exactOptionalPropertyTypes` makes
    // an assigned-then-undefined property a type error.
    const patch: QueryDeepPartialEntity<ParentMessage> = { status };
    if (status === ParentMessageStatus.DELIVERED) patch.delivered_at = at;
    if (status === ParentMessageStatus.READ) {
      patch.read_at = at;
      // A `read` callback can outrun `delivered`; backfill so the timeline is
      // never missing a step it demonstrably passed through.
      patch.delivered_at = message.delivered_at ?? at;
    }
    if (status === ParentMessageStatus.FAILED) {
      patch.failed_at = at;
      patch.error_message = (error ?? 'Provider reported failure').slice(0, 1000);
    }

    await this.messages.update(message.id, patch);
    return true;
  }

  public async findById(id: string): Promise<ParentMessage | null> {
    return this.messages.findOne({ where: { id } });
  }

  /**
   * Return a FAILED/DEAD message to QUEUED so a deliberate admin retry can
   * re-claim it. Without this, `claim()` would refuse — DEAD is terminal, which
   * is exactly what we want for automatic retries and exactly what we must
   * override for a human one. Refuses to resurrect a message that actually
   * reached the guardian.
   */
  public async resetForRetry(id: string): Promise<boolean> {
    const result = await this.messages
      .createQueryBuilder()
      .update(ParentMessage)
      .set({
        status: ParentMessageStatus.QUEUED,
        error_message: null,
        failed_at: null,
        provider_message_id: null,
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...retryable)', {
        retryable: [ParentMessageStatus.FAILED, ParentMessageStatus.DEAD],
      })
      .execute();

    return (result.affected ?? 0) > 0;
  }
}
