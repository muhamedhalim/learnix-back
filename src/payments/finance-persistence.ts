import type { EntityManager } from 'typeorm';

import { GatewayWebhookEvent, PaymentAuditLog, PaymentDomainEvent } from './entities';

/**
 * Manager-scoped writers shared by the finance services. Each one runs on the CALLER's
 * `EntityManager` and never opens a transaction of its own, so the audit row / outbox event /
 * webhook status stays atomic with the financial state change that produced it.
 */

export interface PaymentAuditEntry {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  details: Record<string, unknown>;
}

/** Appends one `payment_audit_logs` row (no client IP: these are server-side actions). */
export async function writePaymentAudit(
  manager: EntityManager,
  entry: PaymentAuditEntry,
): Promise<void> {
  await manager.insert(PaymentAuditLog, {
    actor_id: entry.actorId,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId,
    details: entry.details as never,
    ip_address: null,
  });
}

/**
 * Enqueues one outbox event. `dedupeKey` makes it idempotent: a second insert with the same key
 * is silently ignored (`ON CONFLICT DO NOTHING`), so retried transactions never double-publish.
 */
export async function writeDomainEvent(
  manager: EntityManager,
  eventName: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await manager
    .createQueryBuilder()
    .insert()
    .into(PaymentDomainEvent)
    .values({
      event_name: eventName,
      dedupe_key: dedupeKey,
      payload: payload as never,
      published_at: null,
      attempts: 0,
      last_error: null,
    })
    .orIgnore()
    .execute();
}

/** Marks a webhook event processed and releases every lease/heartbeat/retry field it held. */
export async function markWebhookEventProcessed(
  manager: EntityManager,
  event: GatewayWebhookEvent,
): Promise<void> {
  event.status = 'processed';
  event.processed_at = new Date();
  event.error_message = null;
  event.last_error = null;
  event.lease_token = null;
  event.claimed_by = null;
  event.lease_expires_at = null;
  event.heartbeat_at = null;
  event.next_retry_at = null;
  await manager.save(event);
}
