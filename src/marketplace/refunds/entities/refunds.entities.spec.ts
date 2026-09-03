import { getMetadataArgsStorage } from 'typeorm';

import { MarketplaceRefundRequest } from './marketplace-refund-request.entity';

describe('MarketplaceRefundRequest entity', () => {
  it('allows at most one open refund request per order (FR-199)', () => {
    const index = getMetadataArgsStorage().indices.find(
      (i) => i.target === MarketplaceRefundRequest && i.name === 'UQ_mp_refunds_open_per_order',
    );
    expect(index?.unique).toBe(true);
    expect(index?.where).toContain('requested');
  });

  it('carries both progress snapshots and the eligibility verdict', () => {
    const names = getMetadataArgsStorage()
      .columns.filter((c) => c.target === MarketplaceRefundRequest)
      .map((c) => c.propertyName);
    expect(names).toEqual(
      expect.arrayContaining([
        'progress_bps_at_request',
        'progress_bps_at_processing',
        'eligibility_verdict',
        'is_discretionary',
        'is_removal_driven',
      ]),
    );
  });
});
