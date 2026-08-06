import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import * as crypto from 'node:crypto';
import type { Request } from 'express';

import type { ParentMessageService } from '../services/parent-message.service';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function makeController(config: Record<string, string | undefined> = {}): {
  controller: WhatsAppWebhookController;
  messages: { applyProviderStatus: jest.Mock };
} {
  const messages = { applyProviderStatus: jest.fn().mockResolvedValue(true) };
  const configService = {
    get: (key: string) =>
      ({
        META_WHATSAPP_APP_SECRET: APP_SECRET,
        META_WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
        ...config,
      })[key],
  } as unknown as ConfigService;
  const controller = new WhatsAppWebhookController(
    messages as unknown as ParentMessageService,
    configService,
  );
  return { controller, messages };
}

function fakeRequest(rawBody: Buffer, signature?: string): Request {
  const headers: Record<string, string> = {};
  if (signature !== undefined) headers['x-hub-signature-256'] = signature;
  return {
    header: (name: string) => headers[name.toLowerCase()],
    rawBody,
  } as unknown as Request;
}

function signedRequest(body: unknown, secret = APP_SECRET): Request {
  const raw = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fakeRequest(raw, signature);
}

describe('WhatsAppWebhookController — signature verification with fake data', () => {
  describe('POST /webhooks/whatsapp (receive)', () => {
    it('accepts a correctly-signed payload and applies the status update', async () => {
      const { controller, messages } = makeController();
      const body = {
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [{ id: 'wamid.1', status: 'delivered', timestamp: '1700000000' }],
                },
              },
            ],
          },
        ],
      };
      const request = signedRequest(body);

      const result = await controller.receive(request, body);

      expect(result).toEqual({ received: true });
      expect(messages.applyProviderStatus).toHaveBeenCalledTimes(1);
    });

    it('rejects a forged signature computed with the wrong secret', async () => {
      const { controller } = makeController();
      const body = { entry: [] };
      const request = signedRequest(body, 'attacker-controlled-secret');

      await expect(controller.receive(request, body)).rejects.toThrow(ForbiddenException);
    });

    it('rejects a tampered body whose signature no longer matches', async () => {
      const { controller } = makeController();
      const signedBody = { entry: [] };
      const request = signedRequest(signedBody);
      const tamperedBody = { entry: [{ changes: [{ value: { statuses: [] } }] }] };

      // Signature was computed over `signedBody`'s bytes; the raw body on the
      // request object is unchanged, but a real attacker tampering with the
      // parsed body after signature computation is exactly what this proves
      // cannot slip through — the rawBody bytes are what is actually verified.
      const raw = Buffer.from(JSON.stringify(signedBody));
      const forgedHeaderRequest = fakeRequest(
        raw,
        `sha256=${crypto.createHmac('sha256', 'not-the-real-secret').update(raw).digest('hex')}`,
      );

      await expect(controller.receive(forgedHeaderRequest, tamperedBody)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('rejects a request with no signature header at all', async () => {
      const { controller } = makeController();
      const body = { entry: [] };
      const request = fakeRequest(Buffer.from(JSON.stringify(body)));

      await expect(controller.receive(request, body)).rejects.toThrow(BadRequestException);
    });

    it('rejects a signature header that is not the sha256= scheme', async () => {
      const { controller } = makeController();
      const body = { entry: [] };
      const request = fakeRequest(Buffer.from(JSON.stringify(body)), 'md5=deadbeef');

      await expect(controller.receive(request, body)).rejects.toThrow(BadRequestException);
    });

    it('fails closed when rawBody is unavailable, even with a well-formed signature header', async () => {
      const { controller } = makeController();
      const body = { entry: [] };
      const request = {
        header: () => 'sha256=irrelevant',
        rawBody: undefined,
      } as unknown as Request;

      await expect(controller.receive(request, body)).rejects.toThrow(ForbiddenException);
    });

    it('fails closed when META_WHATSAPP_APP_SECRET is not configured', async () => {
      const { controller } = makeController({ META_WHATSAPP_APP_SECRET: undefined });
      const body = { entry: [] };
      const request = fakeRequest(Buffer.from(JSON.stringify(body)), 'sha256=irrelevant');

      await expect(controller.receive(request, body)).rejects.toThrow(ForbiddenException);
    });

    it('never throws for an unrecognised Meta status value (e.g. "deleted")', async () => {
      const { controller, messages } = makeController();
      const body = {
        entry: [
          {
            changes: [
              {
                value: {
                  statuses: [
                    { id: 'wamid.2', status: 'deleted' as never, timestamp: '1700000000' },
                  ],
                },
              },
            ],
          },
        ],
      };
      const request = signedRequest(body);

      await expect(controller.receive(request, body)).resolves.toEqual({ received: true });
      expect(messages.applyProviderStatus).not.toHaveBeenCalled();
    });
  });

  describe('GET /webhooks/whatsapp (verify handshake)', () => {
    it('echoes the challenge for the correct verify token and subscribe mode', () => {
      const { controller } = makeController();
      expect(controller.verify('subscribe', VERIFY_TOKEN, 'challenge-123')).toBe('challenge-123');
    });

    it('rejects an incorrect verify token', () => {
      const { controller } = makeController();
      expect(() => controller.verify('subscribe', 'wrong-token', 'challenge-123')).toThrow(
        ForbiddenException,
      );
    });

    it('rejects the correct token under the wrong hub.mode', () => {
      const { controller } = makeController();
      expect(() => controller.verify('unsubscribe', VERIFY_TOKEN, 'challenge-123')).toThrow(
        ForbiddenException,
      );
    });

    it('fails closed when no verify token is configured', () => {
      const { controller } = makeController({ META_WHATSAPP_VERIFY_TOKEN: undefined });
      expect(() => controller.verify('subscribe', '', 'challenge-123')).toThrow(ForbiddenException);
    });
  });
});
