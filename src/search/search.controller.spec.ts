import 'reflect-metadata';

import { performanceMetrics } from '../observability/performance-metrics.registry';
import { SearchType } from './dto/search.dto';
import { SearchController } from './search.controller';

describe('SearchController global-search scoping', () => {
  const service = {
    logQuery: jest.fn(),
    searchAll: jest.fn(),
    searchByType: jest.fn(),
  };
  const controller = new SearchController(service as never);

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('passes the authenticated Call Center actor to suggestions without logging an operational query', async () => {
    const actor = {
      userId: 'agent-1',
      email: 'agent@example.test',
      name: 'Agent',
      role: 'call_center',
    };
    service.searchAll.mockResolvedValue({ supportUsers: [] });

    await controller.suggestions({ q: 'ahmed' }, actor);

    expect(service.searchAll).toHaveBeenCalledWith('ahmed', actor);
    expect(service.logQuery).not.toHaveBeenCalled();
  });

  it('returns an actor-scoped support-user search only through the service authorization boundary', async () => {
    const actor = {
      userId: 'agent-1',
      email: 'agent@example.test',
      name: 'Agent',
      role: 'call_center',
    };
    service.searchByType.mockResolvedValue({ data: [], meta: {} });

    await controller.search(
      { q: 'ahmed', type: SearchType.SUPPORT_USERS, page: 1, limit: 20 },
      actor,
    );

    expect(service.searchByType).toHaveBeenCalledWith(
      'ahmed',
      SearchType.SUPPORT_USERS,
      1,
      20,
      actor,
    );
  });

  it('records aggregate telemetry without retaining a sensitive-looking query', async () => {
    const recordSearch = jest.spyOn(performanceMetrics, 'recordSearch');
    service.searchAll.mockResolvedValue({
      courses: [],
      lessons: [],
      books: [],
      teachers: [],
      subjects: [],
      supportUsers: [],
    });

    await controller.search(
      { q: 'student@example.test', type: SearchType.ALL, page: 1, limit: 20 },
      undefined,
    );

    expect(recordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'query',
        type: SearchType.ALL,
        actor: 'anonymous',
        outcome: 'empty',
        resultCount: 0,
      }),
    );
    expect(JSON.stringify(recordSearch.mock.calls)).not.toContain('student@example.test');
  });
});
