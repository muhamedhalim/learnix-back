import { MarketplaceEnrollmentGrantedEvent } from '../events/domain.events';
import { FreeEnrollmentNotificationListener } from './free-enrollment-notification.listener';

function buildListener(opts: { order?: Record<string, unknown> | null; instructor?: Record<string, unknown> | null } = {}) {
  const order = 'order' in opts ? opts.order : { id: 'order-1', course_title_snapshot: 'Intro to Testing', instructor_id: 'instructor-1' };
  const instructor = 'instructor' in opts ? opts.instructor : { id: 'instructor-1', user_id: 'instructor-user-1' };
  const orders = { findOne: jest.fn().mockResolvedValue(order) };
  const instructors = { findOne: jest.fn().mockResolvedValue(instructor) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const listener = new FreeEnrollmentNotificationListener(orders as never, instructors as never, notifications as never);
  return { listener, orders, instructors, notifications };
}

describe('FreeEnrollmentNotificationListener (T119)', () => {
  it('notifies the learner and the instructor, both in-app only and with no SMS/guardian fan-out', async () => {
    const { listener, notifications } = buildListener();

    await listener.handleEnrollmentGranted(
      new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', true),
    );

    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ user_id: 'learner-1' }), false);
    expect(notifications.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ user_id: 'instructor-user-1' }), false);
  });

  it("the learner's message names the course but never a price, payment method or refund window (FR-271)", async () => {
    const { listener, notifications } = buildListener();
    await listener.handleEnrollmentGranted(new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', true));

    const learnerCall = notifications.create.mock.calls[0]![0] as { message: string };
    expect(learnerCall.message).toContain('Intro to Testing');
    expect(learnerCall.message.toLowerCase()).not.toMatch(/paid|payment|refund|price|amount|egp/);
  });

  it("the instructor's message is distinguishable from a sale — states it was free, never an amount (FR-275)", async () => {
    const { listener, notifications } = buildListener();
    await listener.handleEnrollmentGranted(new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', true));

    const instructorCall = notifications.create.mock.calls[1]![0] as { message: string; data: Record<string, unknown> };
    expect(instructorCall.message.toLowerCase()).toContain('free');
    expect(instructorCall.data['is_free']).toBe(true);
  });

  it('ignores a paid (non-zero-value) enrollment grant entirely — that confirmation is a separate, not-yet-built notification', async () => {
    const { listener, notifications, orders } = buildListener();
    await listener.handleEnrollmentGranted(new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', false));

    expect(orders.findOne).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('is a no-op if the order was somehow already gone, never throwing', async () => {
    const { listener, notifications } = buildListener({ order: null });
    await expect(
      listener.handleEnrollmentGranted(new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', true)),
    ).resolves.toBeUndefined();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('still notifies the learner even if the instructor row is missing, and never throws', async () => {
    const { listener, notifications } = buildListener({ instructor: null });
    await expect(
      listener.handleEnrollmentGranted(new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', true)),
    ).resolves.toBeUndefined();
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'learner-1' }), false);
  });

  it('never throws even if notification delivery itself fails — a best-effort side effect, not the transaction', async () => {
    const { listener, notifications } = buildListener();
    notifications.create.mockRejectedValue(new Error('delivery failed'));

    await expect(
      listener.handleEnrollmentGranted(new MarketplaceEnrollmentGrantedEvent('enrollment-1', 'order-1', 'learner-1', 'course-1', true)),
    ).resolves.toBeUndefined();
  });
});
