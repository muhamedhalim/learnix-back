import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import {
  ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS,
  ADMIN_INBOX_OPERATIONAL_CATEGORIES,
  AdminNotificationEvent,
  BUSINESS_ALERT_CATEGORY_PREFIXES,
} from '../constants/admin-notification-events';
import { NotificationOrigin } from '../entities/notification-origin.enum';

/**
 * Restricts a `notifications` query to the rows an administrator's personal
 * inbox (`GET /notifications`, `GET /notifications/unread/count`) may show.
 *
 * Three disjoint ways a row qualifies, each keyed on structured columns and
 * never on the title/message text:
 *
 *  1. `source_event` is a catalogued business event (everything in
 *     `AdminNotificationEvent` except `operational_alert`).
 *  2. `source_event` is `operational_alert` AND the category is one the inbox
 *     accepts (financial / security). The same event carried component-health
 *     and threshold alerts with category `system` before the producer was
 *     fixed; those are excluded here as well as no longer being created.
 *  3. Legacy rows written before the catalog existed: `origin = operational`
 *     with the raw alert key as `source_event`. Only keys with a business
 *     prefix (payment./refund./finance./security./auth.) qualify; legacy
 *     `health-rule:*` / `scheduled_job.*` rows do not.
 *
 * Reads and creation share one rule (`isAdminInboxEligible`) so a row the
 * creation boundary rejects can never reappear through a read path.
 */
export function applyAdminInboxScope<T extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<T>,
  alias: string,
): SelectQueryBuilder<T> {
  const legacyPatterns = BUSINESS_ALERT_CATEGORY_PREFIXES.map(([prefix]) => `${prefix}%`);
  const legacyClauses = legacyPatterns.map(
    (_pattern, index) => `${alias}.source_event LIKE :inboxLegacyPattern${String(index)}`,
  );
  const legacyParams = Object.fromEntries(
    legacyPatterns.map((pattern, index) => [`inboxLegacyPattern${String(index)}`, pattern]),
  );

  return queryBuilder.andWhere(
    `(
      ${alias}.source_event IN (:...inboxEvents)
      OR (${alias}.source_event = :inboxOperationalEvent AND ${alias}.category IN (:...inboxOperationalCategories))
      OR (${alias}.origin = :inboxOperationalOrigin AND (${legacyClauses.join(' OR ')}))
    )`,
    {
      inboxEvents: [...ADMIN_INBOX_ALWAYS_ELIGIBLE_EVENTS],
      inboxOperationalEvent: AdminNotificationEvent.OPERATIONAL_ALERT,
      inboxOperationalCategories: [...ADMIN_INBOX_OPERATIONAL_CATEGORIES],
      inboxOperationalOrigin: NotificationOrigin.OPERATIONAL,
      ...legacyParams,
    },
  );
}
