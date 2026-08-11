import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { UserRole } from './entities/user-role.enum';
import { UserStatus } from './entities/user-status.enum';
import type { User } from './entities/user.entity';
import { UsersService } from './users.service';

const adminActor = {
  userId: 'admin-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: UserRole.ADMIN,
};

function callCenterUser(overrides: Partial<User> = {}): User {
  return {
    id: 'call-center-1',
    username: 'support_agent',
    name: 'Support Agent',
    email: 'support@example.test',
    phone: '01012345678',
    role: UserRole.CALL_CENTER,
    status: UserStatus.APPROVED,
    is_active: true,
    finance_permissions: [],
    created_at: new Date('2026-08-12T09:00:00.000Z'),
    ...overrides,
  } as User;
}

function createService(repository: Record<string, unknown>) {
  const cache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const activityLogs = { recordAuditEvent: jest.fn().mockResolvedValue(undefined) };
  const service = new UsersService(
    repository as unknown as Repository<User>,
    {} as never,
    cache as never,
    { get: jest.fn().mockReturnValue(4) } as never,
    activityLogs as never,
  );
  return { service, cache, activityLogs };
}

describe('UsersService Call Center workforce', () => {
  it('persists a new approved, active Call Center employee and returns the safe list projection', async () => {
    const saved = callCenterUser();
    const repository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockReturnValue(saved),
      save: jest.fn().mockResolvedValue(saved),
    };
    const { service, activityLogs } = createService(repository);

    const result = await service.createCallCenterEmployee(
      {
        username: 'support_agent',
        name: 'Support Agent',
        email: 'SUPPORT@example.test',
        phone: '01012345678',
        password: 'TemporaryPass123',
      },
      adminActor,
      '127.0.0.1',
    );

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: UserRole.CALL_CENTER,
        status: UserStatus.APPROVED,
        is_active: true,
        email: 'support@example.test',
      }),
    );
    expect(repository.save).toHaveBeenCalledWith(saved);
    expect(result).toMatchObject({
      user: {
        id: 'call-center-1',
        role: UserRole.CALL_CENTER,
        access: {
          model: 'role',
          role: UserRole.CALL_CENTER,
          individual_permissions: [],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('password_hash');
    expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('provisions an assigned existing account so it can authenticate as Call Center staff', async () => {
    const existing = callCenterUser({
      role: UserRole.STUDENT,
      status: UserStatus.PENDING,
      is_active: false,
    });
    const repository = {
      findOne: jest.fn().mockResolvedValue(existing),
      save: jest.fn().mockImplementation(async (user: User) => user),
    };
    const { service, activityLogs } = createService(repository);

    const result = await service.assignCallCenterRole(
      existing.id,
      { reason: 'Support onboarding' },
      adminActor,
      null,
    );

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        role: UserRole.CALL_CENTER,
        status: UserStatus.APPROVED,
        is_active: true,
      }),
    );
    expect(result).toMatchObject({
      user: {
        id: existing.id,
        role: UserRole.CALL_CENTER,
        access: { individual_permissions: [] },
      },
    });
    expect(activityLogs.recordAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('lists only persisted Call Center users and exposes the role-based access source', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[callCenterUser()], 1]),
    };
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(query) };
    const { service } = createService(repository);

    const result = await service.findCallCenterEmployees({
      page: 1,
      limit: 10,
      search: 'support',
    });

    expect(query.where).toHaveBeenCalledWith('user.role = :role', {
      role: UserRole.CALL_CENTER,
    });
    expect(query.andWhere).toHaveBeenCalledWith(expect.stringContaining('user.email ILIKE'), {
      search: '%support%',
    });
    expect(result).toMatchObject({
      data: [
        {
          id: 'call-center-1',
          role: UserRole.CALL_CENTER,
          access: { model: 'role', individual_permissions: [] },
        },
      ],
      meta: { total: 1 },
    });
  });

  it('persists a normalized email when an admin edits an employee', async () => {
    const user = callCenterUser({ email: 'old@example.test' });
    const repository = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      save: jest.fn().mockResolvedValue(user),
    };
    const { service } = createService(repository);

    await service.update(user.id, {
      name: 'Updated Agent',
      email: 'NEW@EXAMPLE.TEST',
      phone: '01012345678',
    });

    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Updated Agent', email: 'new@example.test' }),
    );
  });

  it('does not allow a non-admin actor to provision a Call Center employee', async () => {
    const { service } = createService({});

    await expect(
      service.createCallCenterEmployee(
        {
          username: 'support_agent',
          name: 'Support Agent',
          email: 'support@example.test',
          phone: '01012345678',
          password: 'TemporaryPass123',
        },
        { ...adminActor, role: UserRole.CALL_CENTER },
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not convert an Admin or an existing Call Center account through the workforce endpoint', async () => {
    const repository = {
      findOne: jest.fn().mockResolvedValue(callCenterUser({ role: UserRole.ADMIN })),
    };
    const { service } = createService(repository);

    await expect(
      service.assignCallCenterRole('admin-2', {}, adminActor, null),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
