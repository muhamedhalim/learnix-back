import { EventEmitter2 } from '@nestjs/event-emitter';

import { PARENT_EVENT_CHANNEL } from '../events/parent-events';
import { PurchaseParentNotificationListener } from './purchase-parent-notification.listener';

describe('PurchaseParentNotificationListener', () => {
  it('turns a durable payment success into the canonical guardian event', async () => {
    const orders = {
      findOne: jest.fn().mockResolvedValue({
        id: 'order-1',
        student_id: 'student-1',
        product_title_snapshot: 'Math course',
        final_amount_minor: 12500,
        currency: 'EGP',
      }),
    };
    const users = { findOne: jest.fn().mockResolvedValue({ id: 'student-1', name: 'Amina' }) };
    const events = { emit: jest.fn() };
    const listener = new PurchaseParentNotificationListener(
      orders as never,
      users as never,
      events as unknown as EventEmitter2,
    );

    await listener.handlePaymentSucceeded({ order_id: 'order-1' });

    expect(events.emit).toHaveBeenCalledWith(
      PARENT_EVENT_CHANNEL,
      expect.objectContaining({
        studentId: 'student-1',
        subjectId: 'order-1',
        variables: { studentName: 'Amina', itemName: 'Math course', amount: 125, currency: 'EGP' },
      }),
    );
  });
});
