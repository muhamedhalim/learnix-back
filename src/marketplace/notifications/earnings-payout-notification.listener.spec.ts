import {
  MarketplaceEarningClearedEvent,
  MarketplaceEarningReversedEvent,
  MarketplacePayoutApprovedEvent,
  MarketplacePayoutFailedEvent,
  MarketplacePayoutPaidEvent,
  MarketplacePayoutProcessingEvent,
  MarketplacePayoutRejectedEvent,
  MarketplacePayoutRequestedEvent,
} from '../events/domain.events';
import { EarningsPayoutNotificationListener } from './earnings-payout-notification.listener';

function buildListener(instructor: Record<string, unknown> | null = { id: 'instructor-1', user_id: 'instructor-user-1' }) {
  const instructors = { findOne: jest.fn().mockResolvedValue(instructor) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const listener = new EarningsPayoutNotificationListener(instructors as never, notifications as never);
  return { listener, instructors, notifications };
}

describe('EarningsPayoutNotificationListener (T183, FR-276, FR-277)', () => {
  it('notifies on earning cleared, resolved to the instructor user_id', async () => {
    const { listener, instructors, notifications } = buildListener();
    await listener.handleEarningCleared(new MarketplaceEarningClearedEvent('earning-1', 'order-1', 'instructor-1'));

    expect(instructors.findOne).toHaveBeenCalledWith({ where: { id: 'instructor-1' } });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'instructor-user-1', title: 'Earning available' }),
      false,
    );
  });

  it('notifies on earning reversed', async () => {
    const { listener, notifications } = buildListener();
    await listener.handleEarningReversed(new MarketplaceEarningReversedEvent('earning-1', 'order-1', 'instructor-1'));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Earning reversed' }), false);
  });

  it('notifies on payout requested', async () => {
    const { listener, notifications } = buildListener();
    await listener.handlePayoutRequested(new MarketplacePayoutRequestedEvent('request-1', 'instructor-1'));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payout request received' }), false);
  });

  it('notifies on payout approved', async () => {
    const { listener, notifications } = buildListener();
    await listener.handlePayoutApproved(new MarketplacePayoutApprovedEvent('request-1', 'instructor-1'));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payout approved' }), false);
  });

  it('notifies on payout rejected with the reason in the message', async () => {
    const { listener, notifications } = buildListener();
    await listener.handlePayoutRejected(new MarketplacePayoutRejectedEvent('request-1', 'instructor-1', 'Fraudulent bank details'));
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Payout rejected', message: expect.stringContaining('Fraudulent bank details') }),
      false,
    );
  });

  it('notifies on payout processing', async () => {
    const { listener, notifications } = buildListener();
    await listener.handlePayoutProcessing(new MarketplacePayoutProcessingEvent('request-1', 'instructor-1'));
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Payout processing' }), false);
  });

  it('notifies on payout paid with the reference in the message', async () => {
    const { listener, notifications } = buildListener();
    await listener.handlePayoutPaid(new MarketplacePayoutPaidEvent('request-1', 'instructor-1', 'TXN-999'));
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Payout paid', message: expect.stringContaining('TXN-999') }),
      false,
    );
  });

  it('notifies on payout failed with the reason in the message', async () => {
    const { listener, notifications } = buildListener();
    await listener.handlePayoutFailed(new MarketplacePayoutFailedEvent('request-1', 'instructor-1', 'Bank rejected the transfer'));
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Payout failed', message: expect.stringContaining('Bank rejected the transfer') }),
      false,
    );
  });

  it('is a no-op if the instructor record is somehow gone', async () => {
    const { listener, notifications } = buildListener(null);
    await listener.handleEarningCleared(new MarketplaceEarningClearedEvent('earning-1', 'order-1', 'instructor-1'));
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('never throws even if notification delivery fails', async () => {
    const { listener, notifications } = buildListener();
    notifications.create.mockRejectedValue(new Error('boom'));
    await expect(
      listener.handleEarningCleared(new MarketplaceEarningClearedEvent('earning-1', 'order-1', 'instructor-1')),
    ).resolves.toBeUndefined();
  });
});
