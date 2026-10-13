import { ParentMessageStatus } from '../entities';
import type { ParentMessageService } from './parent-message.service';
import { parseSmsEvent, SmsEventsConsumer, toProviderStatus } from './sms-events.consumer';

describe('parseSmsEvent', () => {
  it('parses a raw delivery event', () => {
    const event = parseSmsEvent(
      JSON.stringify({
        eventType: 'TEXT_DELIVERED',
        messageId: 'm1',
        messageStatus: 'DELIVERED',
        destinationPhoneNumber: '+201001234567',
        eventTimestamp: 1760000000000,
      }),
    );
    expect(event).toMatchObject({ eventType: 'TEXT_DELIVERED', messageId: 'm1', failed: false });
    expect(event?.at?.getTime()).toBe(1760000000000);
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

describe('toProviderStatus', () => {
  const event = (eventType: string) => parseSmsEvent(JSON.stringify({ eventType, messageId: 'm' }))!;

  it('maps a handset delivery to DELIVERED and terminal failures to FAILED', () => {
    expect(toProviderStatus(event('TEXT_DELIVERED'))).toBe(ParentMessageStatus.DELIVERED);
    expect(toProviderStatus(event('TEXT_BLOCKED'))).toBe(ParentMessageStatus.FAILED);
    expect(toProviderStatus(event('TEXT_PROTECT_BLOCKED'))).toBe(ParentMessageStatus.FAILED);
  });

  it('ignores intermediate states (the row is already SENT when the send call returns)', () => {
    expect(toProviderStatus(event('TEXT_QUEUED'))).toBeNull();
    expect(toProviderStatus(event('TEXT_SUCCESSFUL'))).toBeNull();
    expect(toProviderStatus(event('TEXT_PENDING'))).toBeNull();
  });
});

describe('SmsEventsConsumer.handle', () => {
  function build(apply: jest.Mock = jest.fn().mockResolvedValue(true)) {
    const messages = { applyProviderStatus: apply } as unknown as ParentMessageService;
    const consumer = new SmsEventsConsumer({ get: () => '' } as never, messages);
    const logger = (consumer as unknown as { logger: { warn: jest.Mock; log: jest.Mock; error: jest.Mock } }).logger;
    logger.warn = jest.fn();
    logger.log = jest.fn();
    logger.error = jest.fn();
    return { consumer, logger, apply };
  }

  it('records a delivery on the guardian message with the provider timestamp', async () => {
    const { consumer, apply } = build();
    await expect(
      consumer.handle({
        Body: JSON.stringify({ eventType: 'TEXT_DELIVERED', messageId: 'aws-1', eventTimestamp: 1760000000000 }),
      }),
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith('aws-1', ParentMessageStatus.DELIVERED, new Date(1760000000000), undefined);
  });

  it('records a failure with the event type as the error and never logs the full phone number', async () => {
    const { consumer, logger, apply } = build();
    const accepted = await consumer.handle({
      Body: JSON.stringify({ eventType: 'TEXT_BLOCKED', messageId: 'aws-2', destinationPhoneNumber: '+201001234567' }),
    });
    expect(accepted).toBe(true);
    expect(apply).toHaveBeenCalledWith('aws-2', ParentMessageStatus.FAILED, expect.any(Date), 'SMS TEXT_BLOCKED');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).not.toContain('+201001234567');
  });

  it('does not touch the database for intermediate states or events without a message id', async () => {
    const { consumer, apply } = build();
    await consumer.handle({ Body: JSON.stringify({ eventType: 'TEXT_SUCCESSFUL', messageId: 'aws-3' }) });
    await consumer.handle({ Body: JSON.stringify({ eventType: 'TEXT_DELIVERED' }) });
    expect(apply).not.toHaveBeenCalled();
  });

  it('leaves the message on the queue (retry, then DLQ) when the database update throws', async () => {
    const { consumer, logger } = build(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(
      consumer.handle({ Body: JSON.stringify({ eventType: 'TEXT_DELIVERED', messageId: 'aws-4' }) }),
    ).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('acknowledges unparseable messages so they do not loop to the DLQ', async () => {
    const { consumer } = build();
    await expect(consumer.handle({ Body: 'garbage' })).resolves.toBe(true);
  });
});
