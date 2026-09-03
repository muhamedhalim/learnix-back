import { CourseReviewStatus } from '../common/enums';
import { MarketplaceOverviewService } from './overview.service';

function buildRepo(count: number, oldest: { toISOString?: () => string } | null) {
  return {
    count: jest.fn().mockResolvedValue(count),
    findOne: jest.fn().mockResolvedValue(oldest ? { submitted_at: oldest, updated_at: oldest, created_at: oldest, requested_at: oldest } : null),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(count),
      getOne: jest.fn().mockResolvedValue(oldest ? { created_at: oldest } : null),
    }),
  };
}

describe('MarketplaceOverviewService (T188, FR-286)', () => {
  it('reports a zero count with a null oldest-waiting-since when a queue is empty', async () => {
    const empty = buildRepo(0, null);
    const service = new MarketplaceOverviewService(empty as never, empty as never, empty as never, empty as never, empty as never);

    const overview = await service.getOverview();

    expect(overview).toEqual({
      applications: { count: 0, oldestWaitingSince: null },
      courses: { count: 0, oldestWaitingSince: null },
      reportedReviews: { count: 0, oldestWaitingSince: null },
      refunds: { count: 0, oldestWaitingSince: null },
      payouts: { count: 0, oldestWaitingSince: null },
    });
  });

  it('reports the count and oldest waiting timestamp for each queue independently', async () => {
    const oldest = new Date('2026-01-01T00:00:00.000Z');
    const applications = buildRepo(2, oldest);
    const courses = buildRepo(1, oldest);
    const reviews = buildRepo(3, oldest);
    const refunds = buildRepo(4, oldest);
    const payouts = buildRepo(5, oldest);
    const service = new MarketplaceOverviewService(applications as never, courses as never, reviews as never, refunds as never, payouts as never);

    const overview = await service.getOverview();

    expect(overview.applications).toEqual({ count: 2, oldestWaitingSince: oldest.toISOString() });
    expect(overview.courses).toEqual({ count: 1, oldestWaitingSince: oldest.toISOString() });
    expect(overview.reportedReviews).toEqual({ count: 3, oldestWaitingSince: oldest.toISOString() });
    expect(overview.refunds).toEqual({ count: 4, oldestWaitingSince: oldest.toISOString() });
    expect(overview.payouts).toEqual({ count: 5, oldestWaitingSince: oldest.toISOString() });
  });

  it('reported-reviews queue matches ReviewModerationService.listForModeration()\'s own default filter', async () => {
    const reviews = buildRepo(0, null);
    const empty = buildRepo(0, null);
    const service = new MarketplaceOverviewService(empty as never, empty as never, reviews as never, empty as never, empty as never);

    await service.getOverview();

    const qb = reviews.createQueryBuilder.mock.results[0]!.value as { where: jest.Mock };
    expect(qb.where).toHaveBeenCalledWith('(r.report_count > 0 OR r.status = :flagged)', { flagged: CourseReviewStatus.FLAGGED });
  });
});
