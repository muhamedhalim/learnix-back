import { CallCenterSupportService } from './callcenter-support.service';

/**
 * DEF-012: the Call Center dashboard reads these workload counts instead of
 * rendering a permanent placeholder. These tests pin the query shape (which
 * filters apply to which count) so the dashboard's numbers stay traceable to
 * the underlying `Complaint` rows.
 */
describe('CallCenterSupportService.dashboardCounts (DEF-012)', () => {
  function buildService(counts: number[]) {
    const getCount = jest.fn();
    for (const count of counts) getCount.mockResolvedValueOnce(count);
    const query = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount,
    };
    const complaintsRepository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const service = new CallCenterSupportService(
      {} as never,
      {} as never,
      {} as never,
      complaintsRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, query };
  }

  it('resolves the five workload counts in Promise.all evaluation order', async () => {
    const { service } = buildService([7, 2, 3, 1, 4]);

    await expect(service.dashboardCounts('agent-1', 4)).resolves.toEqual({
      open_tickets: 7,
      assigned_to_me: 2,
      unassigned_tickets: 3,
      first_response_approaching: 1,
      resolution_approaching: 4,
    });
  });

  it('scopes "assigned to me" to the authenticated agent id, never a client-supplied one', async () => {
    const { service, query } = buildService([0, 0, 0, 0, 0]);

    await service.dashboardCounts('agent-1', 4);

    expect(query.andWhere).toHaveBeenCalledWith('complaint.assigned_agent_id = :agentId', {
      agentId: 'agent-1',
    });
  });

  it('scopes "unassigned" to complaints with no assigned agent', async () => {
    const { service, query } = buildService([0, 0, 0, 0, 0]);

    await service.dashboardCounts('agent-1', 4);

    expect(query.andWhere).toHaveBeenCalledWith('complaint.assigned_agent_id IS NULL');
  });

  it('excludes resolved/closed tickets from every count via the shared open-ticket base filter', async () => {
    const { service, query } = buildService([0, 0, 0, 0, 0]);

    await service.dashboardCounts('agent-1', 4);

    expect(query.andWhere).toHaveBeenCalledWith('complaint.status NOT IN (:...terminal)', {
      terminal: ['resolved', 'closed'],
    });
  });

  it('bounds the "approaching breach" window using the caller-supplied warning-window hours', async () => {
    const { service, query } = buildService([0, 0, 0, 0, 0]);

    await service.dashboardCounts('agent-1', 2);

    const horizonCalls = query.andWhere.mock.calls.filter(
      ([sql]: [string]) => sql === 'complaint.first_response_due_at <= :horizon',
    );
    expect(horizonCalls).toHaveLength(1);
    const [, params] = horizonCalls[0] as [string, { horizon: Date }];
    expect(params.horizon.getTime()).toBeGreaterThan(Date.now());
    expect(params.horizon.getTime()).toBeLessThanOrEqual(Date.now() + 2 * 60 * 60 * 1000 + 1000);
  });
});
