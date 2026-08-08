import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import { SmsSenderService } from './sms-sender.service';

jest.mock('twilio', () => {
  return jest.fn(() => ({
    messages: {
      create: jest.fn().mockResolvedValue({ sid: 'SM123' }),
    },
  }));
});

function makeService(values: Record<string, string | undefined>): {
  service: SmsSenderService;
  twilioCreate: jest.Mock;
} {
  const config = { get: jest.fn((key: string) => values[key]) };
  const service = new SmsSenderService(config as unknown as ConfigService);
  const twilioCreate = (service as unknown as { twilioClient: { messages: { create: jest.Mock } } })
    .twilioClient.messages.create;
  return { service, twilioCreate };
}

const CONFIGURED = {
  TWILIO_ACCOUNT_SID: 'AC123',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_PHONE_NUMBER: '+15005550006',
};

describe('SmsSenderService — staging sandbox enforcement', () => {
  it('sends for real when APP_ENV is not staging', async () => {
    const { service, twilioCreate } = makeService(CONFIGURED);

    const result = await service.sendSms('+201234567890', 'hello');

    expect(twilioCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, messageId: 'SM123' });
  });

  it('sandboxes a non-allowlisted recipient on staging: no Twilio call, reported as success', async () => {
    const { service, twilioCreate } = makeService({
      ...CONFIGURED,
      APP_ENV: 'staging',
      SMS_ALLOWLIST: '+201000000001',
    });

    const result = await service.sendSms('+201234567890', 'hello');

    expect(twilioCreate).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  it('still sends for real when the recipient IS on the staging allowlist', async () => {
    const { service, twilioCreate } = makeService({
      ...CONFIGURED,
      APP_ENV: 'staging',
      SMS_ALLOWLIST: '+201234567890',
    });

    const result = await service.sendSms('+201234567890', 'hello');

    expect(twilioCreate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, messageId: 'SM123' });
  });

  it('never falls back to a live send when sandboxed, even with no allowlist configured at all', async () => {
    const { service, twilioCreate } = makeService({ ...CONFIGURED, APP_ENV: 'staging' });

    await service.sendSms('+201234567890', 'hello');

    expect(twilioCreate).not.toHaveBeenCalled();
  });
});

describe('SmsSenderService — guardian phone numbers are never logged in full', () => {
  const PHONE = '+201234567890';

  it('masks the recipient on a successful send', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      const { service } = makeService(CONFIGURED);

      await service.sendSms(PHONE, 'hello');

      const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain(PHONE);
      expect(logged).not.toContain('201234567890');
      // Last three digits are retained so support can confirm the recipient.
      expect(logged).toContain('***890');
      // The provider correlation handle is still there.
      expect(logged).toContain('SM123');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('masks the recipient on a failed send', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { service, twilioCreate } = makeService(CONFIGURED);
      twilioCreate.mockRejectedValue(new Error('Twilio 21610: unsubscribed recipient'));

      const result = await service.sendSms(PHONE, 'hello');

      expect(result.success).toBe(false);
      const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain(PHONE);
      expect(logged).toContain('***890');
      // The provider error is preserved — it is what makes the log actionable.
      expect(logged).toContain('21610');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
