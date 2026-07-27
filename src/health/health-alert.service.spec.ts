import type { Repository } from 'typeorm';

import type { MailService } from '../mail/mail.service';
import type { NotificationsService } from '../notifications/services/notifications.service';
import type { User } from '../users/entities/user.entity';
import { HealthAlertRule } from './entities';
import { HealthAlertService } from './health-alert.service';
import type { HealthComponentResult } from './health.types';

describe('HealthAlertService', () => {
  it('honours cooldowns and prevents an alert storm', async () => {
    const rule = {
      id: 'rule',
      key: 'redis-memory',
      name: 'Redis memory',
      component_id: 'redis',
      metric: 'memoryUsagePercent',
      operator: 'gte',
      threshold: 80,
      duration_seconds: 0,
      cooldown_seconds: 1800,
      severity: 'critical',
      channels: ['in_app'],
      recipients: [],
      enabled: true,
      last_triggered_at: new Date(),
    } as HealthAlertRule;
    const rules = {
      findBy: jest.fn().mockResolvedValue([rule]),
      save: jest.fn(),
    } as unknown as Repository<HealthAlertRule>;
    const users = { find: jest.fn() } as unknown as Repository<User>;
    const notifications = {
      create: jest.fn(),
    } as unknown as NotificationsService;
    const mail = { isConfigured: jest.fn() } as unknown as MailService;
    const service = new HealthAlertService(rules, users, notifications, mail);
    const component = {
      id: 'redis',
      name: 'Redis',
      category: 'cache',
      status: 'warning',
      latencyMs: 10,
      checkedAt: new Date().toISOString(),
      lastSuccessAt: null,
      failureCount: 0,
      availabilityPercent: 100,
      message: 'pressure',
      metadata: { memoryUsagePercent: 95 },
      warnings: [],
      errorCode: null,
      dependencies: [],
      recommendation: null,
    } satisfies HealthComponentResult;
    await service.evaluate([component]);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(rules.save).not.toHaveBeenCalled();
  });
});
