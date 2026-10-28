import {
  MarketplaceRefundAwaitingPayoutEvent,
  MarketplaceRefundCompletedEvent,
  MarketplaceRefundFailedEvent,
  MarketplaceRefundRefusedEvent,
  MarketplaceRefundRequestedEvent,
} from '../events/domain.events';
import { RefundNotificationListener } from './refund-notification.listener';

function buildListener(
  order: Record<string, unknown> | null = {
    id: 'order-1',
    learner_id: 'learner-1',
    course_title_snapshot: 'React Basics',
  },
  instructor: Record<string, unknown> | null = { id: 'instructor-1', user_id: 'instructor-user-1' },
) {
  const orders = { findOne: jest.fn().mockResolvedValue(order) };
  const instructors = { findOne: jest.fn().mockResolvedValue(instructor) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const listener = new RefundNotificationListener(
    orders as never,
    instructors as never,
    notifications as never,
  );
  return { listener, orders, instructors, notifications };
}

describe('RefundNotificationListener (T147, FR-273)', () => {
  it('notifies the learner when a refund request is received', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleRequested(
      new MarketplaceRefundRequestedEvent('refund-1', 'order-1', 'learner-1'),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'learner-1',
        title: 'Refund request received',
        message: expect.stringContaining('React Basics'),
      }),
      false,
    );
  });

  it('names the failed condition in a refusal notification', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleRefused(
      new MarketplaceRefundRefusedEvent('refund-1', 'order-1', 'REFUND_WINDOW_EXPIRED'),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'learner-1', message: expect.stringContaining('window') }),
      false,
    );
  });

  it('notifies both the learner and the instructor on completion, distinguishing a removal-driven refund', async () => {
    const { listener, notifications, instructors } = buildListener();
    await listener.handleCompleted(
      new MarketplaceRefundCompletedEvent('refund-1', 'order-1', 'learner-1', 'instructor-1', true),
    );

    expect(instructors.findOne).toHaveBeenCalledWith({ where: { id: 'instructor-1' } });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'learner-1', title: expect.stringContaining('removed') }),
      false,
    );
    // Resolved to instructor.user_id — never the raw event.instructorId
    // (which is MarketplaceInstructor.id, not a users.id).
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'instructor-user-1',
        title: expect.stringContaining('removal'),
      }),
      false,
    );
  });

  it('notifies only the learner on a non-removal-driven completion, and resolves the instructor to their user_id', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleCompleted(
      new MarketplaceRefundCompletedEvent(
        'refund-1',
        'order-1',
        'learner-1',
        'instructor-1',
        false,
      ),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'learner-1', title: 'Refund completed' }),
      false,
    );
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'instructor-user-1', title: 'A refund was issued' }),
      false,
    );
  });

  it('skips the instructor notification (without throwing) if the instructor record is somehow gone', async () => {
    const { listener, notifications } = buildListener(undefined, null);
    await listener.handleCompleted(
      new MarketplaceRefundCompletedEvent(
        'refund-1',
        'order-1',
        'learner-1',
        'instructor-1',
        false,
      ),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'learner-1' }),
      false,
    );
    expect(notifications.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'A refund was issued' }),
      false,
    );
  });

  it('notifies the learner when processing fails', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleFailed(
      new MarketplaceRefundFailedEvent('refund-1', 'order-1', 'Gateway timed out'),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'learner-1', title: 'Refund could not be completed' }),
      false,
    );
  });

  it('tells the learner an approved refund is on its way, not that it failed (D1)', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleAwaitingPayout(
      new MarketplaceRefundAwaitingPayoutEvent('refund-1', 'order-1'),
    );

    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'learner-1',
        title: 'Refund approved',
        message: expect.stringContaining('React Basics'),
      }),
      false,
    );
    expect(notifications.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Refund could not be completed' }),
      false,
    );
  });

  it('is a no-op if the order is somehow gone', async () => {
    const { listener, notifications } = buildListener(null);
    await listener.handleRequested(
      new MarketplaceRefundRequestedEvent('refund-1', 'order-1', 'learner-1'),
    );
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('never throws even if notification delivery fails', async () => {
    const { listener, notifications } = buildListener();
    notifications.create.mockRejectedValue(new Error('boom'));
    await expect(
      listener.handleRequested(
        new MarketplaceRefundRequestedEvent('refund-1', 'order-1', 'learner-1'),
      ),
    ).resolves.toBeUndefined();
  });
});
