import { Test, TestingModule } from '@nestjs/testing';

import { Job, UnrecoverableError } from 'bullmq';

import { ParentEventType } from '../../common/events/parent-event-type.enum';
import { GuardiansService } from '../../guardians/guardians.service';
import { PreferredLanguage } from '../../guardians/entities';
import { JOB_TYPES } from '../../queues/queues.constants';
import { ChannelRegistryService } from '../channels/channel-registry.service';
import type { ChannelSendResult, ParentChannel } from '../channels/parent-channel.interface';
import { MessageChannel } from '../entities';
import { ParentMessageService } from '../services/parent-message.service';
import { ParentNotificationJobsService } from '../services/parent-notification-jobs.service';
import { TemplateRendererService } from '../templates/template-renderer.service';
import { ParentNotificationProcessor } from './parent-notification.processor';

const TARGET = {
  guardian_id: 'g1',
  student_id: 's1',
  phone_e164: '+201012345678',
  full_name: 'Parent',
  preferred_language: PreferredLanguage.AR,
  whatsapp_capable: true,
};

function makeChannel(channel: MessageChannel, result: ChannelSendResult): ParentChannel {
  return {
    channel,
    isConfigured: () => true,
    supports: () => true,
    send: jest.fn(async () => result),
  };
}

function deliverJob(overrides: Partial<Job> = {}): Job {
  return {
    name: JOB_TYPES.PARENT.DELIVER,
    attemptsMade: 0,
    data: {
      eventType: ParentEventType.EXAM_GRADED,
      studentId: 's1',
      subjectId: 'attempt-1',
      variables: { studentName: 'Ahmed', examName: 'Math', code: 'SECRET123' },
    },
    opts: { attempts: 5 },
    ...overrides,
  } as unknown as Job;
}

describe('ParentNotificationProcessor', () => {
  let processor: ParentNotificationProcessor;
  let guardians: { findNotificationTargets: jest.Mock; markWhatsAppIncapable: jest.Mock };
  let channels: { resolve: jest.Mock; anyConfigured: jest.Mock };
  let messages: {
    claim: jest.Mock;
    markSent: jest.Mock;
    markFailed: jest.Mock;
    markDead: jest.Mock;
    findById: jest.Mock;
    resetForRetry: jest.Mock;
  };
  let jobs: { deadLetter: jest.Mock; enqueueDelivery: jest.Mock };

  beforeEach(async () => {
    guardians = {
      findNotificationTargets: jest.fn(async () => [TARGET]),
      markWhatsAppIncapable: jest.fn(),
    };
    channels = { resolve: jest.fn(), anyConfigured: jest.fn(() => true) };
    messages = {
      claim: jest.fn(async () => ({ claimed: true, message: { id: 'm1' } })),
      markSent: jest.fn(),
      markFailed: jest.fn(),
      markDead: jest.fn(),
      findById: jest.fn(),
      resetForRetry: jest.fn(async () => true),
    };
    jobs = { deadLetter: jest.fn(), enqueueDelivery: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ParentNotificationProcessor,
        TemplateRendererService,
        { provide: GuardiansService, useValue: guardians },
        { provide: ChannelRegistryService, useValue: channels },
        { provide: ParentMessageService, useValue: messages },
        { provide: ParentNotificationJobsService, useValue: jobs },
      ],
    }).compile();

    processor = module.get(ParentNotificationProcessor);
  });

  it('sends over the first channel and records SENT — never DELIVERED', async () => {
    const whatsapp = makeChannel(MessageChannel.WHATSAPP, {
      accepted: true,
      providerMessageId: 'wamid.1',
    });
    channels.resolve.mockReturnValue([whatsapp]);

    await processor.process(deliverJob());

    expect(messages.markSent).toHaveBeenCalledWith('m1', MessageChannel.WHATSAPP, 'wamid.1');
    expect(messages.markDead).not.toHaveBeenCalled();
  });

  it('never persists an OTP code in the message variables', async () => {
    channels.resolve.mockReturnValue([makeChannel(MessageChannel.SMS, { accepted: true })]);

    await processor.process(deliverJob());

    const claimed = messages.claim.mock.calls[0]?.[0] as { variables: Record<string, unknown> };
    expect(claimed.variables).not.toHaveProperty('code');
    expect(claimed.variables).toHaveProperty('studentName', 'Ahmed');
  });

  it('skips entirely when the message was already claimed and sent', async () => {
    const whatsapp = makeChannel(MessageChannel.WHATSAPP, { accepted: true });
    channels.resolve.mockReturnValue([whatsapp]);
    messages.claim.mockResolvedValue({ claimed: false, message: { id: 'm1' } });

    await processor.process(deliverJob());

    expect(whatsapp.send).not.toHaveBeenCalled();
    expect(messages.markSent).not.toHaveBeenCalled();
  });

  it('falls through to SMS when WhatsApp fails permanently', async () => {
    const whatsapp = makeChannel(MessageChannel.WHATSAPP, {
      accepted: false,
      permanent: true,
      recipientNotOnChannel: true,
      error: 'not a WhatsApp user',
    });
    const sms = makeChannel(MessageChannel.SMS, { accepted: true, providerMessageId: 'SM1' });
    channels.resolve.mockReturnValue([whatsapp, sms]);

    await processor.process(deliverJob());

    expect(sms.send).toHaveBeenCalled();
    expect(messages.markSent).toHaveBeenCalledWith('m1', MessageChannel.SMS, 'SM1');
    // Remembered, so future sends skip the wasted WhatsApp round trip.
    expect(guardians.markWhatsAppIncapable).toHaveBeenCalledWith('g1');
  });

  it('does NOT downgrade to SMS on a transient WhatsApp failure — it retries', async () => {
    const whatsapp = makeChannel(MessageChannel.WHATSAPP, {
      accepted: false,
      error: 'Meta 500',
    });
    const sms = makeChannel(MessageChannel.SMS, { accepted: true });
    channels.resolve.mockReturnValue([whatsapp, sms]);

    await expect(processor.process(deliverJob())).rejects.toThrow(/transient/i);

    expect(sms.send).not.toHaveBeenCalled();
    expect(messages.markFailed).toHaveBeenCalled();
    expect(messages.markDead).not.toHaveBeenCalled();
  });

  it('marks the message DEAD when every channel permanently refuses', async () => {
    const whatsapp = makeChannel(MessageChannel.WHATSAPP, {
      accepted: false,
      permanent: true,
      error: 'template missing',
    });
    const sms = makeChannel(MessageChannel.SMS, {
      accepted: false,
      permanent: true,
      error: 'landline',
    });
    channels.resolve.mockReturnValue([whatsapp, sms]);

    await processor.process(deliverJob());

    expect(messages.markDead).toHaveBeenCalledWith('m1', 'landline');
  });

  it('does not retry when the student has no eligible guardian', async () => {
    guardians.findNotificationTargets.mockResolvedValue([]);

    await expect(processor.process(deliverJob())).resolves.toBeUndefined();
    expect(messages.claim).not.toHaveBeenCalled();
  });

  it('is unrecoverable when no channel is configured at all', async () => {
    channels.anyConfigured.mockReturnValue(false);

    await expect(processor.process(deliverJob())).rejects.toThrow(UnrecoverableError);
  });

  describe('dead-letter hook', () => {
    it('parks the job only after the final attempt', async () => {
      await processor.onFailed(deliverJob({ attemptsMade: 3 }) as never, new Error('boom'));
      expect(jobs.deadLetter).not.toHaveBeenCalled();

      await processor.onFailed(deliverJob({ attemptsMade: 5 }) as never, new Error('boom'));
      expect(jobs.deadLetter).toHaveBeenCalledTimes(1);
    });
  });

  describe('redelivery', () => {
    it('unsticks a DEAD message and re-enqueues it, bypassing the dedup id', async () => {
      messages.findById.mockResolvedValue({
        id: 'm1',
        status: 'dead',
        event_type: ParentEventType.EXAM_GRADED,
        student_id: 's1',
        idempotency_key: 'exam_graded:attempt-1:g1',
        variables: { studentName: 'Ahmed' },
      });

      await processor.process({
        name: JOB_TYPES.PARENT.REDELIVER,
        data: { parentMessageId: 'm1' },
      } as unknown as Job);

      expect(messages.resetForRetry).toHaveBeenCalledWith('m1');
      expect(jobs.enqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ subjectId: 'attempt-1' }),
        { bypassDedup: true },
      );
    });

    it('refuses to resend a message already confirmed delivered', async () => {
      messages.findById.mockResolvedValue({ id: 'm1', status: 'delivered' });

      await processor.process({
        name: JOB_TYPES.PARENT.REDELIVER,
        data: { parentMessageId: 'm1' },
      } as unknown as Job);

      expect(jobs.enqueueDelivery).not.toHaveBeenCalled();
    });
  });
});
