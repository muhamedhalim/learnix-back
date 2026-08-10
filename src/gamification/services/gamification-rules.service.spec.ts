import { NotFoundException } from '@nestjs/common';

import { GamificationRulesService } from './gamification-rules.service';

describe('GamificationRulesService (DEF-018)', () => {
  function buildService() {
    const rows: Array<Record<string, unknown>> = [];
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      setLock: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };
    const ruleSets = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      find: jest.fn().mockResolvedValue(rows),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => ({ id: 'rule-set-2', ...value })),
    };
    const manager = { getRepository: jest.fn().mockReturnValue(ruleSets) };
    const dataSource = { transaction: jest.fn((fn: (m: unknown) => unknown) => fn(manager)) };
    const service = new GamificationRulesService(ruleSets as never, dataSource as never);
    return { service, ruleSets, qb, manager, dataSource };
  }

  const validDto = {
    xp_base_by_difficulty: { easy: 12, medium: 22, hard: 40, expert: 60 },
    combo_bonuses: [{ at: 5, xp: 20 }],
    streak_daily_bonus: 30,
    streak_milestones: [{ days: 7, xp: 150 }],
  };

  it('falls back to the constants-derived default when no ruleset row exists yet', async () => {
    const { service, qb } = buildService();
    qb.getOne.mockResolvedValue(null);

    const resolved = await service.resolveCurrent();

    expect(resolved).toMatchObject({
      id: null,
      version_number: null,
      streak_daily_bonus: 25,
    });
    expect(resolved.xp_base_by_difficulty).toEqual({ easy: 10, medium: 20, hard: 35, expert: 55 });
  });

  it('resolves the newest enabled, already-effective row when one exists', async () => {
    const { service, qb } = buildService();
    qb.getOne.mockResolvedValue({
      id: 'rule-set-1',
      version_number: 3,
      xp_base_by_difficulty: { easy: 15, medium: 25, hard: 45, expert: 65 },
      combo_bonuses: [{ at: 5, xp: 20 }],
      streak_daily_bonus: 30,
      streak_milestones: [{ days: 7, xp: 150 }],
    });

    const resolved = await service.resolveCurrent();

    expect(resolved.id).toBe('rule-set-1');
    expect(resolved.version_number).toBe(3);
    expect(resolved.streak_daily_bonus).toBe(30);
    expect(qb.where).toHaveBeenCalledWith('rule_set.enabled = true');
  });

  it('caches the resolution for 60s so recordSolve does not hit the DB on every answer', async () => {
    const { service, qb } = buildService();
    qb.getOne.mockResolvedValue(null);

    await service.resolveCurrent();
    await service.resolveCurrent();

    expect(qb.getOne).toHaveBeenCalledTimes(1);
  });

  it('invalidate() forces the next resolveCurrent() to re-query', async () => {
    const { service, qb } = buildService();
    qb.getOne.mockResolvedValue(null);

    await service.resolveCurrent();
    service.invalidate();
    await service.resolveCurrent();

    expect(qb.getOne).toHaveBeenCalledTimes(2);
  });

  it('creates version 1 when no rows exist yet, and increments from the newest existing version', async () => {
    const { service, qb, ruleSets } = buildService();
    qb.getOne.mockResolvedValue({ version_number: 4 });

    const created = await service.create(validDto, 'admin-1');

    expect(ruleSets.save).toHaveBeenCalledWith(
      expect.objectContaining({
        version_number: 5,
        created_by: 'admin-1',
        enabled: true,
      }),
    );
    expect(created.version_number).toBe(5);
  });

  it('maps the flat DTO difficulty fields onto the Difficulty-enum-keyed JSON column', async () => {
    const { service, ruleSets } = buildService();

    await service.create(validDto, 'admin-1');

    expect(ruleSets.save).toHaveBeenCalledWith(
      expect.objectContaining({
        xp_base_by_difficulty: { easy: 12, medium: 22, hard: 40, expert: 60 },
      }),
    );
  });

  it('rejects duplicate combo-bonus thresholds before touching the database', async () => {
    const { service, ruleSets } = buildService();

    await expect(
      service.create(
        { ...validDto, combo_bonuses: [{ at: 5, xp: 20 }, { at: 5, xp: 40 }] },
        'admin-1',
      ),
    ).rejects.toThrow(/Duplicate/);
    expect(ruleSets.save).not.toHaveBeenCalled();
  });

  it('rejects duplicate streak-milestone thresholds before touching the database', async () => {
    const { service, ruleSets } = buildService();

    await expect(
      service.create(
        { ...validDto, streak_milestones: [{ days: 7, xp: 100 }, { days: 7, xp: 200 }] },
        'admin-1',
      ),
    ).rejects.toThrow(/Duplicate/);
    expect(ruleSets.save).not.toHaveBeenCalled();
  });

  it('setEnabled toggles only the enabled flag and invalidates the cache', async () => {
    const { service, ruleSets, qb } = buildService();
    const row = { id: 'rule-set-1', version_number: 2, enabled: true };
    ruleSets.findOne.mockResolvedValue(row);
    ruleSets.save.mockImplementation(async (value: unknown) => value);
    qb.getOne.mockResolvedValue(null);
    await service.resolveCurrent(); // warm the cache

    await service.setEnabled('rule-set-1', false);
    await service.resolveCurrent();

    expect(row.enabled).toBe(false);
    // One warm-up call + one post-invalidate call = 2 real queries.
    expect(qb.getOne).toHaveBeenCalledTimes(2);
  });

  it('setEnabled on an unknown id raises NotFoundException without writing anything', async () => {
    const { service, ruleSets } = buildService();
    ruleSets.findOne.mockResolvedValue(null);

    await expect(service.setEnabled('missing', false)).rejects.toBeInstanceOf(NotFoundException);
    expect(ruleSets.save).not.toHaveBeenCalled();
  });
});
