import {
  MarketplaceApplicationApprovedEvent,
  MarketplaceApplicationRejectedEvent,
} from '../events/domain.events';
import { ApplicationDecisionNotificationListener } from './application-decision-notification.listener';

function build(application: Record<string, unknown> | null) {
  const applications = { findOne: jest.fn().mockResolvedValue(application) };
  const notifications = { create: jest.fn().mockResolvedValue({}) };
  const mail = { send: jest.fn().mockResolvedValue(true) };
  const listener = new ApplicationDecisionNotificationListener(
    applications as never,
    notifications as never,
    mail as never,
  );
  return { listener, notifications, mail };
}

const signedIn = { id: 'app-1', applicant_email: null, display_name: 'Nour' };
const publicApplicant = {
  id: 'app-2',
  applicant_email: 'layla@example.com',
  display_name: 'Layla <b>',
};

describe('ApplicationDecisionNotificationListener (MP-20)', () => {
  it('tells a signed-in applicant their application was approved', async () => {
    const { listener, notifications, mail } = build(signedIn);
    await listener.handleApproved(
      new MarketplaceApplicationApprovedEvent('app-1', 'user-1', 'instr-1'),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        title: 'Your instructor application was approved',
      }),
      false,
    );
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('sends nothing extra to an approved public applicant: the account-setup email already tells them', async () => {
    const { listener, notifications, mail } = build(publicApplicant);
    await listener.handleApproved(
      new MarketplaceApplicationApprovedEvent('app-2', 'user-new', 'instr-2'),
    );
    expect(notifications.create).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('gives a signed-in applicant the rejection reason in-app', async () => {
    const { listener, notifications, mail } = build(signedIn);
    await listener.handleRejected(
      new MarketplaceApplicationRejectedEvent('app-1', 'user-1', 'Please add a portfolio link'),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-1',
        title: 'Your instructor application was not approved',
        message: expect.stringContaining('Please add a portfolio link'),
      }),
      false,
    );
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('emails a rejected public applicant, who has no account, and escapes the reason in the HTML', async () => {
    const { listener, notifications, mail } = build(publicApplicant);
    await listener.handleRejected(
      new MarketplaceApplicationRejectedEvent(
        'app-2',
        null,
        'Needs <script>alert(1)</script> more detail',
      ),
    );

    expect(notifications.create).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0]?.[0] as { to: string; text: string; html: string };
    expect(message.to).toBe('layla@example.com');
    expect(message.text).toContain('Needs <script>alert(1)</script> more detail');
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('does nothing for a rejected public application that has no contact email', async () => {
    const { listener, mail } = build({ id: 'app-3', applicant_email: null });
    await listener.handleRejected(new MarketplaceApplicationRejectedEvent('app-3', null, 'No'));
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('never throws when delivery fails: the decision is already committed', async () => {
    const approved = build(signedIn);
    approved.notifications.create.mockRejectedValue(new Error('boom'));
    await expect(
      approved.listener.handleApproved(
        new MarketplaceApplicationApprovedEvent('app-1', 'user-1', 'instr-1'),
      ),
    ).resolves.toBeUndefined();

    const rejected = build(publicApplicant);
    rejected.mail.send.mockRejectedValue(new Error('queue down'));
    await expect(
      rejected.listener.handleRejected(
        new MarketplaceApplicationRejectedEvent('app-2', null, 'No'),
      ),
    ).resolves.toBeUndefined();
  });
});
