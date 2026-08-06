import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

import { AxiosError } from 'axios';
import { of, throwError } from 'rxjs';

import { PreferredLanguage } from '../../guardians/entities';
import type { RenderedMessage } from '../templates/template.types';
import type { ChannelTarget } from './parent-channel.interface';
import { WhatsAppMetaChannel } from './whatsapp-meta.channel';

const TARGET: ChannelTarget = {
  guardianId: 'g1',
  phoneE164: '+201012345678',
  whatsappCapable: true,
};

const TEMPLATED: RenderedMessage = {
  templateKey: 'exam_graded.ar',
  body: 'plain text',
  whatsappTemplate: {
    name: 'exam_graded_ar',
    language: PreferredLanguage.AR,
    bodyParameters: ['Ahmed'],
  },
};

function makeChannel(
  http: Partial<HttpService>,
  configured = true,
  extraConfig: Record<string, string> = {},
): WhatsAppMetaChannel {
  const config = {
    get: (key: string) =>
      configured
        ? (
            {
              META_WHATSAPP_PHONE_NUMBER_ID: 'pnid',
              META_WHATSAPP_ACCESS_TOKEN: 'token',
              ...extraConfig,
            } as Record<string, string>
          )[key]
        : undefined,
  } as unknown as ConfigService;
  return new WhatsAppMetaChannel(http as HttpService, config);
}

function metaError(code: number, status = 400): AxiosError {
  return {
    isAxiosError: true,
    response: { status, data: { error: { code, message: `meta error ${String(code)}` } } },
    message: 'request failed',
  } as unknown as AxiosError;
}

describe('WhatsAppMetaChannel', () => {
  it('reports itself unconfigured when credentials are absent', () => {
    const channel = makeChannel({}, false);
    expect(channel.isConfigured()).toBe(false);
    expect(channel.supports(TARGET)).toBe(false);
  });

  it('does not claim to support a guardian who is not on WhatsApp', () => {
    const channel = makeChannel({ post: jest.fn() });
    expect(channel.supports({ ...TARGET, whatsappCapable: false })).toBe(false);
  });

  it('posts a template message and returns the provider message id', async () => {
    const post = jest.fn(() => of({ data: { messages: [{ id: 'wamid.ABC' }] } }));
    const channel = makeChannel({ post: post as never });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(result).toEqual({ accepted: true, providerMessageId: 'wamid.ABC' });

    const [url, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toContain('/pnid/messages');
    expect(payload).toMatchObject({
      messaging_product: 'whatsapp',
      // Meta wants the number without a leading '+'.
      to: '201012345678',
      type: 'template',
      template: { name: 'exam_graded_ar', language: { code: 'ar' } },
    });
  });

  it('refuses free-form text: a business-initiated message needs an approved template', async () => {
    const post = jest.fn();
    const channel = makeChannel({ post: post as never });

    const result = await channel.send(TARGET, { templateKey: 'x.ar', body: 'hi' });

    expect(result.accepted).toBe(false);
    expect(result.permanent).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ['recipient is not a WhatsApp user', 131_026, true],
    ['re-engagement required', 131_047, false],
    ['template does not exist', 132_001, false],
    ['phone number not registered', 133_010, true],
  ])('treats "%s" as permanent', async (_label, code, notOnChannel) => {
    const channel = makeChannel({
      post: jest.fn(() => throwError(() => metaError(code))) as never,
    });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(result.accepted).toBe(false);
    expect(result.permanent).toBe(true);
    expect(result.recipientNotOnChannel ?? false).toBe(notOnChannel);
  });

  it('treats a 500 as transient so BullMQ retries the same channel', async () => {
    const channel = makeChannel({
      post: jest.fn(() => throwError(() => metaError(1, 500))) as never,
    });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(result.accepted).toBe(false);
    expect(result.permanent).toBeUndefined();
  });

  it('treats a 429 as transient, not as a permanent 4xx', async () => {
    const channel = makeChannel({
      post: jest.fn(() => throwError(() => metaError(4, 429))) as never,
    });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(result.accepted).toBe(false);
    expect(result.permanent).toBeUndefined();
  });

  it('sandboxes a non-allowlisted recipient on staging: no HTTP call, reported as accepted', async () => {
    const post = jest.fn();
    const channel = makeChannel({ post: post as never }, true, {
      APP_ENV: 'staging',
      SMS_ALLOWLIST: '+201000000001',
    });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(post).not.toHaveBeenCalled();
    expect(result).toEqual({ accepted: true });
  });

  it('still sends for real when the recipient IS on the staging allowlist', async () => {
    const post = jest.fn(() => of({ data: { messages: [{ id: 'wamid.ABC' }] } }));
    const channel = makeChannel({ post: post as never }, true, {
      APP_ENV: 'staging',
      SMS_ALLOWLIST: TARGET.phoneE164,
    });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ accepted: true, providerMessageId: 'wamid.ABC' });
  });

  it('never returns the raw phone number in the error string', async () => {
    const channel = makeChannel({
      post: jest.fn(() => throwError(() => metaError(131_026))) as never,
    });

    const result = await channel.send(TARGET, TEMPLATED);

    expect(result.error).not.toContain('201012345678');
  });
});
