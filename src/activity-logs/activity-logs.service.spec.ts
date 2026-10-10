import type { Repository } from 'typeorm';

import { ActivityLogsService } from './activity-logs.service';
import type { ActivityLog } from './entities/activity-log.entity';
import type { AuditLog } from './entities/audit-log.entity';

function buildQueryBuilder() {
  const qb = {
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    offset: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  return qb;
}

describe('ActivityLogsService.getAuditLogs target_id filter', () => {
  const targetId = '5f1f7e3a-3b0a-4f43-9d5e-0f6a7a7d3e11';

  function build() {
    const qb = buildQueryBuilder();
    const auditRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const service = new ActivityLogsService(
      {} as unknown as Repository<ActivityLog>,
      auditRepo as unknown as Repository<AuditLog>,
    );
    return { service, qb };
  }

  it('binds target_id as a query parameter instead of interpolating it', async () => {
    const { service, qb } = build();

    await service.getAuditLogs({ targetType: 'user', targetId, page: 2, limit: 20 });

    expect(qb.andWhere).toHaveBeenCalledWith('log.target_id = :targetId', { targetId });
    for (const [sql] of qb.andWhere.mock.calls as Array<[string]>) {
      expect(sql).not.toContain(targetId);
    }
    expect(qb.offset).toHaveBeenCalledWith(20);
    expect(qb.limit).toHaveBeenCalledWith(20);
  });

  it('selects only the admin id, name and email', async () => {
    const { service, qb } = build();

    await service.getAuditLogs({});

    expect(qb.addSelect).toHaveBeenCalledWith(['admin.id', 'admin.name', 'admin.email']);
    expect(qb.andWhere).not.toHaveBeenCalledWith(
      expect.stringContaining('target_id'),
      expect.anything(),
    );
  });
});
