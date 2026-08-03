import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Order } from '../../payments/entities/order.entity';
import { User } from '../../users/entities/user.entity';
import { CoursePurchasedEvent, PARENT_EVENT_CHANNEL } from '../events/parent-events';

/** Converts the durable payment outbox fact into the canonical guardian event. */
@Injectable()
export class PurchaseParentNotificationListener {
  constructor(
    @InjectRepository(Order)
    private readonly orders: Repository<Order>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @OnEvent('payment.succeeded')
  public async handlePaymentSucceeded(payload: { order_id?: string }): Promise<void> {
    if (!payload.order_id) return;
    const order = await this.orders.findOne({ where: { id: payload.order_id } });
    if (!order) return;
    const student = await this.users.findOne({ where: { id: order.student_id } });
    if (!student) return;

    this.eventEmitter.emit(
      PARENT_EVENT_CHANNEL,
      new CoursePurchasedEvent(student.id, order.id, {
        studentName: student.name,
        itemName: order.product_title_snapshot,
        amount: Number(order.final_amount_minor ?? 0) / 100,
        currency: order.currency,
      }),
    );
  }
}
