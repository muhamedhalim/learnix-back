import { ConfigService } from '@nestjs/config';

import { CommissionService } from '../../payments/services/commission.service';
import { MarketplaceCommissionScope } from '../common/enums';
import { MarketplaceCommissionService } from './commission.service';
import type { MarketplaceCommissionSetting } from './entities';

function buildService(existingRows: Partial<MarketplaceCommissionSetting>[] = []) {
  const settings = {
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        existingRows
          .filter((row) => {
            if (where['scope'] !== undefined && row.scope !== where['scope']) return false;
            return true;
          })
          .sort((a, b) => (b.effective_from?.getTime() ?? 0) - (a.effective_from?.getTime() ?? 0))[0] ?? null
      );
    }),
    create: jest.fn((data: Partial<MarketplaceCommissionSetting>) => data as MarketplaceCommissionSetting),
    save: jest.fn(async (entity: MarketplaceCommissionSetting) => ({ id: 'setting-1', ...entity })),
  };
  const commission = new CommissionService(new ConfigService({}));
  const service = new MarketplaceCommissionService(settings as never, commission);
  return { service, settings };
}

describe('MarketplaceCommissionService (T095)', () => {
  it('falls back to the launch default (3000 bps) when no rate has ever been configured', async () => {
    const { service } = buildService([]);
    const resolution = await service.resolveEffectiveRate();
    expect(resolution.rateBps).toBe(3000);
    expect(resolution.scope).toBe(MarketplaceCommissionScope.PLATFORM);
  });

  it('computes the worked example: 500 at 20% yields exactly 100/400', () => {
    const { service } = buildService();
    const result = service.calculate(500, 2000);
    expect(result.platformCommissionMinor).toBe(100);
    expect(result.teacherEarningMinor).toBe(400);
  });

  it('gives the instructor the extra minor unit on an odd residue (floor rounds the commission down)', () => {
    const { service } = buildService();
    // 101 at 30% = 30.3 -> floor to 30, instructor gets the remaining 71 (not 30/71 rounded the other way).
    const result = service.calculate(101, 3000);
    expect(result.platformCommissionMinor).toBe(30);
    expect(result.teacherEarningMinor).toBe(71);
    expect(result.platformCommissionMinor + result.teacherEarningMinor).toBe(101);
  });

  it('commission + earning always reconciles to the captured amount, across a randomised sweep', () => {
    const { service } = buildService();
    for (let i = 0; i < 500; i++) {
      const netMinor = Math.floor(Math.random() * 10_000_000);
      const rateBps = Math.floor(Math.random() * 10_001);
      const result = service.calculate(netMinor, rateBps);
      expect(result.platformCommissionMinor + result.teacherEarningMinor).toBe(netMinor);
      expect(Number.isInteger(result.platformCommissionMinor)).toBe(true);
      expect(Number.isInteger(result.teacherEarningMinor)).toBe(true);
    }
  });

  it('setRate() supersedes the prior effective row rather than mutating it (FR-136 append-only history)', async () => {
    const existing: Partial<MarketplaceCommissionSetting> = {
      id: 'old',
      scope: MarketplaceCommissionScope.PLATFORM,
      scope_ref_id: null,
      currency: null,
      rate_bps: 3000,
      effective_from: new Date('2026-01-01T00:00:00.000Z'),
      superseded_at: null,
    };
    const { service, settings } = buildService([existing]);

    await service.setRate({ scope: MarketplaceCommissionScope.PLATFORM, rateBps: 2500, createdBy: 'admin-1' });

    expect(settings.save).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 'old', superseded_at: expect.any(Date) }));
    expect(settings.save).toHaveBeenNthCalledWith(2, expect.objectContaining({ rate_bps: 2500 }));
  });
});
