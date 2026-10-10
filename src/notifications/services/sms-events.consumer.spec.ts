import { parseSmsEvent, SmsEventsConsumer } from './sms-events.consumer';

describe('parseSmsEvent', () => {
  it('parses a raw delivery event', () => {
    const event = parseSmsEvent(
      JSON.stringify({ eventType: 'TEXT_DELIVERED', messageId: 'm1', messageStatus: 'DELIVERED', destinationPhoneNumber: '+201001234567' }),
    );
    expect(event).toMatchObject({ eventType: 'TEXT_DELIVERED', messageId: 'm1', failed: false });
  });

  it('unwraps an SNS envelope and flags terminal failures', () => {
    const inner = JSON.stringify({ eventType: 'TEXT_CARRIER_UNREACHABLE', messageId: 'm2' });
    expect(parseSmsEvent(JSON.stringify({ Message: inner }))?.failed).toBe(true);
  });

  it('ignores malformed and unrelated bodies', () => {
    expect(parseSmsEvent('not json')).toBeNull();
    expect(parseSmsEvent('{"hello":1}')).toBeNull();
  });
});

describe('SmsEventsConsumer.handle', () => {
  it('acknowledges the message and never logs the full phone number', async () => {
    const consumer = new SmsEventsConsumer({ get: () => '' } as never);
    const logger = (consumer as unknown as { logger: { warn: jest.Mock; log: jest.Mock } }).logger;
    logger.warn = jest.fn();
    logger.log = jest.fn();
    const accepted = await consumer.handle({
      Body: JSON.stringify({ eventType: 'TEXT_BLOCKED', destinationPhoneNumber: '+201001234567' }),
    });
    expect(accepted).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).not.toContain('+201001234567');
  });

  it('acknowledges unparseable messages so they do not loop to the DLQ', async () => {
    const consumer = new SmsEventsConsumer({ get: () => '' } as never);
    await expect(consumer.handle({ Body: 'garbage' })).resolves.toBe(true);
  });
});
