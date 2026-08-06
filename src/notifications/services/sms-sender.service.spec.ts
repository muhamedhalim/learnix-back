import type { ConfigService } from '@nestjs/config';

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
