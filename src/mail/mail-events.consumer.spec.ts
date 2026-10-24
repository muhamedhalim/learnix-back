import { MailEventsConsumer } from './mail-events.consumer';

function make() {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['insert', 'into', 'values', 'orIgnore']) qb[m] = jest.fn(() => qb);
  qb['execute'] = jest.fn().mockResolvedValue({});
  const repo = { createQueryBuilder: jest.fn(() => qb) };
  const consumer = new MailEventsConsumer({ get: jest.fn() } as never, repo as never);
  return { consumer, qb };
}

const sns = (event: Record<string, unknown>) => ({ Body: JSON.stringify({ Message: JSON.stringify(event) }) });

describe('MailEventsConsumer suppression (F-34)', () => {
  it('suppresses every recipient of a permanent bounce, lower-cased, ignoring duplicates', async () => {
    const { consumer, qb } = make();
    const ok = await consumer.handle(
      sns({
        eventType: 'Bounce',
        bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'Gone@Example.test' }] },
      }),
    );
    expect(ok).toBe(true);
    expect(qb['values']).toHaveBeenCalledWith([{ email: 'gone@example.test', reason: 'bounce' }]);
    expect(qb['orIgnore']).toHaveBeenCalled();
  });

  it('suppresses a spam complainant', async () => {
    const { consumer, qb } = make();
    await consumer.handle(
      sns({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'a@b.test' }] } }),
    );
    expect(qb['values']).toHaveBeenCalledWith([{ email: 'a@b.test', reason: 'complaint' }]);
  });

  it('does not suppress a transient bounce', async () => {
    const { consumer, qb } = make();
    await consumer.handle(
      sns({
        eventType: 'Bounce',
        bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@b.test' }] },
      }),
    );
    expect(qb['execute']).not.toHaveBeenCalled();
  });

  it('lets a storage failure propagate so the message is retried', async () => {
    const { consumer, qb } = make();
    qb['execute']!.mockRejectedValue(new Error('db down'));
    await expect(
      consumer.handle(
        sns({
          eventType: 'Bounce',
          bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.test' }] },
        }),
      ),
    ).rejects.toThrow('db down');
  });
});
