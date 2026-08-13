import { ComplaintsService } from './complaints.service';

/** DEF-012: `unassigned=true` is the smallest filter addition needed so the
 * dashboard's "Unassigned tickets" card can deep-link into a real filtered
 * list, instead of a route/query that doesn't exist. */
describe('ComplaintsService.getSupportTickets — unassigned filter (DEF-012)', () => {
  function buildService() {
    const query = {
      leftJoin: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    const complaintsRepository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const service = new ComplaintsService(
      complaintsRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, query };
  }

  it('adds an IS NULL clause on assigned_agent_id when unassigned=true', async () => {
    const { service, query } = buildService();

    await service.getSupportTickets({ page: 1, limit: 20, unassigned: true });

    expect(query.andWhere).toHaveBeenCalledWith('complaint.assigned_agent_id IS NULL');
  });

  it('does not add the unassigned clause when the filter is absent', async () => {
    const { service, query } = buildService();

    await service.getSupportTickets({ page: 1, limit: 20 });

    expect(query.andWhere).not.toHaveBeenCalledWith('complaint.assigned_agent_id IS NULL');
  });

  it('still supports assigned_agent_id equality (unchanged) alongside the new filter', async () => {
    const { service, query } = buildService();

    await service.getSupportTickets({ page: 1, limit: 20, assigned_agent_id: 'agent-1' });

    expect(query.andWhere).toHaveBeenCalledWith('complaint.assigned_agent_id = :assignedAgentId', {
      assignedAgentId: 'agent-1',
    });
  });

  it('mirrors the supportReport() "delayed" definition exactly when overdue=true', async () => {
    const { service, query } = buildService();

    await service.getSupportTickets({ page: 1, limit: 20, overdue: true });

    expect(query.andWhere).toHaveBeenCalledWith('complaint.status NOT IN (:...overdueTerminal)', {
      overdueTerminal: ['resolved', 'closed'],
    });
    expect(query.andWhere).toHaveBeenCalledWith(
      '(complaint.first_response_due_at <= NOW() OR complaint.resolution_due_at <= NOW())',
    );
  });
});
