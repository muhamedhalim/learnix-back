import { Module } from '@nestjs/common';

import { NotificationsModule } from '../../notifications/notifications.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CommerceModule } from '../commerce/commerce.module';
import { InstructorsModule } from '../instructors/instructors.module';
import { CourseCompletionNotificationListener } from './course-completion-notification.listener';
import { EarningsPayoutNotificationListener } from './earnings-payout-notification.listener';
import { FreeEnrollmentNotificationListener } from './free-enrollment-notification.listener';
import { RefundNotificationListener } from './refund-notification.listener';
import { ReviewNotificationListener } from './review-notification.listener';

/**
 * T119, T132. `CommerceModule` supplies `Repository<MarketplaceOrder>`,
 * `InstructorsModule` supplies `Repository<MarketplaceInstructor>`,
 * `CatalogModule` supplies `Repository<MarketplaceCourse>`, and the
 * academic `NotificationsModule` supplies `NotificationsService` — reused,
 * not reimplemented, for both delivery and the in-app persistence/read
 * model a learner's/instructor's notification inbox already shares across
 * academic and marketplace notifications alike.
 */
@Module({
  imports: [CommerceModule, InstructorsModule, CatalogModule, NotificationsModule],
  providers: [
    FreeEnrollmentNotificationListener,
    CourseCompletionNotificationListener,
    RefundNotificationListener,
    ReviewNotificationListener,
    EarningsPayoutNotificationListener,
  ],
})
export class MarketplaceNotificationsModule {}
