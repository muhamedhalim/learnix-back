import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GamificationCampaignsService } from './gamification-campaigns.service';

describe('GamificationCampaignsService (DEF-018)', () => {
  function buildService() {
    const campaigns = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn().mockImplementation(async (value) => ({ id: 'campaign-1', ...value })),
      createQueryBuilder: jest.fn(),
    };
    const lessons = { findOne: jest.fn() };
    const service = new GamificationCampaignsService(campaigns as never, lessons as never);
    return { service, campaigns, lessons };
  }

  const dto = { lesson_id: 'lesson-1', title: 'Midterm push', bonus_xp: 20 };

  it('creates a campaign only when the teacher owns the target lesson', async () => {
    const { service, lessons, campaigns } = buildService();
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', teacher_id: 'teacher-1' });

    const created = await service.createForTeacher('teacher-1', dto);

    expect(lessons.findOne).toHaveBeenCalledWith({ where: { id: 'lesson-1', teacher_id: 'teacher-1' } });
    expect(campaigns.save).toHaveBeenCalledWith(
      expect.objectContaining({ teacher_id: 'teacher-1', lesson_id: 'lesson-1', bonus_xp: 20, enabled: true }),
    );
    expect(created.id).toBe('campaign-1');
  });

  it('refuses to create a campaign for a lesson the teacher does not own (404, not 403 — hides existence)', async () => {
    const { service, lessons, campaigns } = buildService();
    lessons.findOne.mockResolvedValue(null);

    await expect(service.createForTeacher('teacher-1', dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(campaigns.save).not.toHaveBeenCalled();
  });

  it('rejects an end date at or before the start date', async () => {
    const { service, lessons, campaigns } = buildService();
    lessons.findOne.mockResolvedValue({ id: 'lesson-1', teacher_id: 'teacher-1' });

    await expect(
      service.createForTeacher('teacher-1', {
        ...dto,
        start_at: '2026-06-01T00:00:00Z',
        end_at: '2026-06-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(campaigns.save).not.toHaveBeenCalled();
  });

  it('update() only ever touches a campaign owned by the requesting teacher', async () => {
    const { service, campaigns } = buildService();
    campaigns.findOne.mockResolvedValue(null);

    await expect(
      service.update('teacher-1', 'campaign-owned-by-someone-else', { enabled: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(campaigns.findOne).toHaveBeenCalledWith({
      where: { id: 'campaign-owned-by-someone-else', teacher_id: 'teacher-1' },
    });
  });

  it('update() can disable a campaign without touching its bonus_xp or window', async () => {
    const { service, campaigns } = buildService();
    const existing = {
      id: 'campaign-1',
      teacher_id: 'teacher-1',
      lesson_id: 'lesson-1',
      title: 'Midterm push',
      bonus_xp: 20,
      enabled: true,
      start_at: new Date('2026-01-01T00:00:00Z'),
      end_at: null,
    };
    campaigns.findOne.mockResolvedValue(existing);

    await service.update('teacher-1', 'campaign-1', { enabled: false });

    expect(campaigns.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, bonus_xp: 20 }));
  });

  it('activeForLesson only matches an enabled campaign inside its start/end window', async () => {
    const { service, campaigns } = buildService();
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({ id: 'campaign-1', bonus_xp: 20 }),
    };
    campaigns.createQueryBuilder.mockReturnValue(qb);

    const result = await service.activeForLesson('lesson-1', new Date('2026-06-15T00:00:00Z'));

    expect(qb.where).toHaveBeenCalledWith('campaign.lesson_id = :lessonId', { lessonId: 'lesson-1' });
    expect(qb.andWhere).toHaveBeenCalledWith('campaign.enabled = true');
    expect(qb.andWhere).toHaveBeenCalledWith('campaign.start_at <= :at', {
      at: new Date('2026-06-15T00:00:00Z'),
    });
    expect(qb.andWhere).toHaveBeenCalledWith('(campaign.end_at IS NULL OR campaign.end_at > :at)', {
      at: new Date('2026-06-15T00:00:00Z'),
    });
    expect(result).toMatchObject({ id: 'campaign-1', bonus_xp: 20 });
  });

  it('activeForLesson reads through the transaction manager when one is supplied', async () => {
    const { service, campaigns } = buildService();
    const qb = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), getOne: jest.fn().mockResolvedValue(null) };
    const managerRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    const manager = { getRepository: jest.fn().mockReturnValue(managerRepo) };

    await service.activeForLesson('lesson-1', new Date(), manager as never);

    expect(manager.getRepository).toHaveBeenCalled();
    expect(campaigns.createQueryBuilder).not.toHaveBeenCalled();
  });
});
