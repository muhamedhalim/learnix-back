import type { ConfigService } from '@nestjs/config';

import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { mockClient } from 'aws-sdk-client-mock';

import { resolveSmsProvider, SmsSenderService } from './sms-sender.service';

jest.mock('twilio', () => jest.fn(() => ({ messages: { create: jest.fn() } })));

const sms = mockClient(PinpointSMSVoiceV2Client);
beforeEach(() => sms.reset());

const make = (values: Record<string, string | undefined>): SmsSenderService =>
  new SmsSenderService({ get: (key: string) => values[key] } as unknown as ConfigService);

const AWS = {
  SMS_PROVIDER: 'aws',
  SMS_AWS_ORIGINATION_IDENTITY: 'Learnix',
  SMS_AWS_CONFIGURATION_SET: 'learnix-sms',
  SMS_AWS_PROTECT_CONFIGURATION_ID: 'protect-egypt-only',
};

describe('resolveSmsProvider', () => {
  const get = (env: Record<string, string>) => (key: string) => env[key];
  it('is explicit when SMS_PROVIDER is set', () => {
    expect(resolveSmsProvider(get({ SMS_PROVIDER: 'aws' }))).toBe('aws');
    expect(resolveSmsProvider(get({ SMS_PROVIDER: 'TWILIO' }))).toBe('twilio');
    expect(resolveSmsProvider(get({ SMS_PROVIDER: 'none', TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' }))).toBe('none');
  });
  it('keeps the historic default: Twilio when its credentials exist, otherwise off', () => {
    expect(resolveSmsProvider(get({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' }))).toBe('twilio');
    expect(resolveSmsProvider(get({}))).toBe('none');
  });
});

describe('SmsSenderService with AWS End User Messaging', () => {
  it('sends a transactional message from the sender ID with the protect configuration', async () => {
    sms.on(SendTextMessageCommand).resolves({ MessageId: 'aws-msg-1' });
    const service = make(AWS);

    expect(service.providerName).toBe('aws');
    const result = await service.sendSms('01012345678', 'Your code is 123456');

    expect(result).toEqual({ success: true, messageId: 'aws-msg-1' });
    expect(sms.commandCalls(SendTextMessageCommand)[0]!.args[0].input).toMatchObject({
      DestinationPhoneNumber: '+201012345678',
      OriginationIdentity: 'Learnix',
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: 'learnix-sms',
      ProtectConfigurationId: 'protect-egypt-only',
      MessageBody: 'Your code is 123456',
    });
  });

  it('refuses destinations outside Egypt before calling AWS (SMS-pumping defence)', async () => {
    const service = make(AWS);
    const result = await service.sendSms('+14155550123', 'hi');
    expect(result.success).toBe(false);
    expect(sms.commandCalls(SendTextMessageCommand)).toHaveLength(0);
  });

  it('allowed prefixes are configurable', async () => {
    sms.on(SendTextMessageCommand).resolves({ MessageId: 'x' });
    const service = make({ ...AWS, SMS_ALLOWED_COUNTRY_PREFIXES: '+20,+966' });
    expect((await service.sendSms('+966501234567', 'hi')).success).toBe(true);
  });

  it('reports a failure by error name without leaking the provider message', async () => {
    sms.on(SendTextMessageCommand).rejects(
      Object.assign(new Error('Phone number +201012345678 blocked'), { name: 'ConflictException' }),
    );
    const result = await make(AWS).sendSms('+201012345678', 'hi');
    expect(result).toEqual({ success: false, error: 'ConflictException' });
  });

  it('stays disabled (and sends nothing) without an origination identity', async () => {
    const service = make({ SMS_PROVIDER: 'aws' });
    expect(service.isConfigured()).toBe(false);
    expect((await service.sendSms('+201012345678', 'hi')).success).toBe(false);
  });

  it('honours the staging sandbox: nothing is sent, the caller sees success', async () => {
    const service = make({ ...AWS, APP_ENV: 'staging', SMS_MODE: 'sandbox' });
    const result = await service.sendSms('+201012345678', 'hi');
    expect(result.success).toBe(true);
    expect(sms.commandCalls(SendTextMessageCommand)).toHaveLength(0);
  });
});
