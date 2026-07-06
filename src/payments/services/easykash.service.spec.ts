import * as crypto from 'node:crypto';

import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { EasyKashWebhookDto } from '../dto/easykash-webhook.dto';
import { EasyKashService } from './easykash.service';

/**
 * Security tests for EasyKash callback HMAC verification, following the official
 * spec (callback-response-verification): HMAC-SHA512 over
 * ProductCode+Amount+ProductType+PaymentMethod+status+easykashRef+customerReference,
 * hex digest, compared to `signatureHash`.
 */
describe('EasyKashService — callback HMAC verification', () => {
  const HMAC_SECRET = 'test-hmac-secret';

  // Values from the documentation's worked example. Their documented
  // concatenation is: EDV447111.00Direct PayCash Through FawryPAID2911105009TEST11111
  const buildPayload = (): EasyKashWebhookDto => ({
    ProductCode: 'EDV44711',
    Amount: '1.00',
    ProductType: 'Direct Pay',
    PaymentMethod: 'Cash Through Fawry',
    status: 'PAID',
    easykashRef: '2911105009',
    customerReference: 'TEST11111',
    signatureHash: '',
  });

  const DOC_CONCATENATION = 'EDV447111.00Direct PayCash Through FawryPAID2911105009TEST11111';

  /** Recompute the signature exactly as the docs specify (SHA512, hex). */
  const sign = (p: EasyKashWebhookDto, secret: string): string => {
    const dataStr =
      p.ProductCode +
      p.Amount +
      p.ProductType +
      p.PaymentMethod +
      p.status +
      p.easykashRef +
      p.customerReference;
    return crypto.createHmac('sha512', secret).update(dataStr).digest('hex');
  };

  const buildService = async (secret: string): Promise<EasyKashService> => {
    const config: Partial<Record<string, string>> = {
      EASYKASH_API_KEY: 'key',
      EASYKASH_API_URL: 'https://back.easykash.net',
      EASYKASH_HMAC_SECRET: secret,
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EasyKashService,
        { provide: ConfigService, useValue: { get: (k: string) => config[k] } },
      ],
    }).compile();
    return module.get(EasyKashService);
  };

  it('concatenates the seven signed fields exactly as the docs specify', () => {
    const p = buildPayload();
    const dataStr =
      p.ProductCode +
      p.Amount +
      p.ProductType +
      p.PaymentMethod +
      p.status +
      p.easykashRef +
      p.customerReference;
    expect(dataStr).toBe(DOC_CONCATENATION);
  });

  it('accepts a signature produced per the documented SHA512 scheme', async () => {
    const service = await buildService(HMAC_SECRET);
    const p = buildPayload();
    expect(service.verifyHmac(p, sign(p, HMAC_SECRET))).toBe(true);
  });

  it('rejects the callback when EASYKASH_HMAC_SECRET is not configured (fail-closed)', async () => {
    const service = await buildService('');
    const p = buildPayload();
    expect(service.verifyHmac(p, sign(p, HMAC_SECRET))).toBe(false);
  });

  it('rejects a forged / wrong-secret signature', async () => {
    const service = await buildService(HMAC_SECRET);
    const p = buildPayload();
    expect(service.verifyHmac(p, 'deadbeef')).toBe(false);
    expect(service.verifyHmac(p, sign(p, 'wrong-secret'))).toBe(false);
  });

  it('rejects an empty / non-string signature', async () => {
    const service = await buildService(HMAC_SECRET);
    const p = buildPayload();
    expect(service.verifyHmac(p, '')).toBe(false);
    expect(service.verifyHmac(p, undefined as unknown as string)).toBe(false);
  });

  it('rejects when a signed field was tampered after signing', async () => {
    const service = await buildService(HMAC_SECRET);
    const p = buildPayload();
    const validSig = sign(p, HMAC_SECRET);
    const tampered = { ...p, Amount: '9999.00' };
    expect(service.verifyHmac(tampered, validSig)).toBe(false);
  });
});
