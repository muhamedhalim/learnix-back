import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Order } from '../../payments/entities/order.entity';
import { AdminNotificationEvent } from '../constants/admin-notification-events';
import { AdminNotificationsService } from '../services/admin-notifications.service';

/**
 * Turns durable domain events into admin-facing notifications. Reuses the
 * events other listeners already consume (`payment.succeeded` is also how
 * `PurchaseParentNotificationListener` learns of a sale) rather than adding
 * new coupling into the services that emit them — see
 * `AdminNotificationEvent` for the full catalog this feeds.
 */
@Injectable()
export class AdminAlertsListener {
  public constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    private readonly adminNotifications: AdminNotificationsService,
  ) {}

  @OnEvent('payment.succeeded')
  public async handlePaymentSucceeded(payload: { order_id?: string }): Promise<void> {
    if (!payload.order_id) return;
    const order = await this.orders.findOne({ where: { id: payload.order_id } });
    if (!order) return;

    await this.adminNotifications.notifyAdmins(AdminNotificationEvent.PURCHASE_COMPLETED, {
      title: 'New purchase completed',
      message: `Order ${order.order_number} for "${order.product_title_snapshot}" was paid (${order.currency} ${(
        Number(order.final_amount_minor ?? 0) / 100
      ).toFixed(2)}).`,
      link: '/admin/payments?tab=orders',
      data: { order_id: order.id, order_number: order.order_number },
      dedupeKey: order.id,
    });
  }

  @OnEvent('teacher.registration_pending')
  public async handleTeacherRegistrationPending(payload: {
    userId: string;
    name: string;
    email: string;
  }): Promise<void> {
    await this.adminNotifications.notifyAdmins(
      AdminNotificationEvent.TEACHER_REGISTRATION_PENDING,
      {
        title: 'New instructor registration request',
        message: `${payload.name} (${payload.email}) requested to register as an instructor and is awaiting approval.`,
        link: '/admin/teachers?status=pending',
        data: { user_id: payload.userId },
        dedupeKey: payload.userId,
      },
    );
  }

  @OnEvent('package.published')
  public async handlePackagePublished(payload: {
    packageId: string;
    title: string;
    teacherId: string;
  }): Promise<void> {
    await this.adminNotifications.notifyAdmins(AdminNotificationEvent.COURSE_PUBLISHED_FOR_REVIEW, {
      title: 'New course published',
      message: `"${payload.title}" was published and is now live for students.`,
      link: '/admin/packages',
      data: { package_id: payload.packageId, teacher_id: payload.teacherId },
      dedupeKey: payload.packageId,
    });
  }
}
