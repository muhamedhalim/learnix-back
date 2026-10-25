import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { createHmac } from 'node:crypto';
import type { Request } from 'express';

import { MeetingProvider } from '../../entities/meeting-provider.enum';
import type { MeetingAccountsService } from '../meeting-accounts.service';
import { ZoomWebhookController } from './zoom-webhook.controller';

const SECRET = 'zoom-secret-token';

function sign(timestamp: string, raw: string, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
}

function request(
  body: unknown,
  overrides: { signature?: string; timestamp?: string; rawBody?: Buffer | null } = {},
): Request {
  const raw = JSON.stringify(body);
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string | undefined> = {
    'x-zm-request-timestamp': timestamp,
    'x-zm-signature': overrides.signature ?? sign(timestamp, raw),
  };
  return {
    header: (name: string) => headers[name.toLowerCase()],
    rawBody: overrides.rawBody === null ? undefined : (overrides.rawBody ?? Buffer.from(raw)),
  } as unknown as Request;
}

describe('ZoomWebhookController', () => {
  const accounts = { markRevokedByProviderAccount: jest.fn().mockResolvedValue(1) };

  function controller(secret = SECRET): ZoomWebhookController {
    return new ZoomWebhookController(
      accounts as unknown as MeetingAccountsService,
      { get: (key: string) => (key === 'ZOOM_WEBHOOK_SECRET_TOKEN' ? secret : undefined) } as unknown as ConfigService,
    );
  }

  beforeEach(() => jest.clearAllMocks());

  it('answers the endpoint-validation challenge with the HMAC of the plain token', async () => {
    const body = { event: 'endpoint.url_validation', payload: { plainToken: 'abc123' } };

    const response = await controller().handle(request(body), body);

    expect(response).toEqual({
      plainToken: 'abc123',
      encryptedToken: createHmac('sha256', SECRET).update('abc123').digest('hex'),
    });
  });

  it('revokes the matching connection on app_deauthorized', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'zoom-user-1' } };

    await expect(controller().handle(request(body), body)).resolves.toEqual({});

    expect(accounts.markRevokedByProviderAccount).toHaveBeenCalledWith(MeetingProvider.ZOOM, 'zoom-user-1');
  });

  it('ignores unrelated events', async () => {
    const body = { event: 'meeting.started', payload: {} };

    await expect(controller().handle(request(body), body)).resolves.toEqual({});
    expect(accounts.markRevokedByProviderAccount).not.toHaveBeenCalled();
  });

  it('rejects a forged signature without touching any account', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'victim' } };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const forged = sign(timestamp, JSON.stringify(body), 'wrong-secret');

    await expect(controller().handle(request(body, { signature: forged, timestamp }), body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(accounts.markRevokedByProviderAccount).not.toHaveBeenCalled();
  });

  it('does not act as an HMAC oracle for unsigned validation requests', async () => {
    const body = { event: 'endpoint.url_validation', payload: { plainToken: 'v0:1:{"event":"app_deauthorized"}' } };

    await expect(
      controller().handle(request(body, { signature: 'v0=deadbeef' }), body),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a body that was altered after signing', async () => {
    const signedBody = { event: 'app_deauthorized', payload: { user_id: 'user-1' } };
    const tampered = { event: 'app_deauthorized', payload: { user_id: 'user-2' } };
    const timestamp = String(Math.floor(Date.now() / 1000));

    await expect(
      controller().handle(
        request(tampered, { signature: sign(timestamp, JSON.stringify(signedBody)), timestamp }),
        tampered,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a stale (replayed) request even with a valid signature', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'user-1' } };
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);

    await expect(controller().handle(request(body, { timestamp: stale }), body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(accounts.markRevokedByProviderAccount).not.toHaveBeenCalled();
  });

  it('rejects requests missing signature headers', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'user-1' } };
    const req = { header: () => undefined, rawBody: Buffer.from('{}') } as unknown as Request;

    await expect(controller().handle(req, body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when the secret token is not configured', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'user-1' } };

    await expect(controller('').handle(request(body), body)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('fails closed when the raw body is unavailable', async () => {
    const body = { event: 'app_deauthorized', payload: { user_id: 'user-1' } };

    await expect(controller().handle(request(body, { rawBody: null }), body)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
