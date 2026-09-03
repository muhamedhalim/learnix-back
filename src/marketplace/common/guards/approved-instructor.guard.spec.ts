import type { ExecutionContext } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { MarketplaceInstructorStatus } from '../enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';
import { ApprovedInstructorGuard } from './approved-instructor.guard';

function buildContext(method: string, userId: string | undefined): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = { method, user: userId ? { userId } : undefined };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function buildRepo(row: Partial<MarketplaceInstructor> | null): jest.Mocked<Repository<MarketplaceInstructor>> {
  return {
    findOne: jest.fn(async () => row),
  } as unknown as jest.Mocked<Repository<MarketplaceInstructor>>;
}

describe('ApprovedInstructorGuard', () => {
  it('rejects an unauthenticated request', async () => {
    const guard = new ApprovedInstructorGuard(buildRepo(null));
    const { context } = buildContext('GET', undefined);
    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('rejects a request from a user with no instructor capability at all (an ordinary student/teacher)', async () => {
    const guard = new ApprovedInstructorGuard(buildRepo(null));
    const { context } = buildContext('GET', 'user-1');
    await expect(guard.canActivate(context)).rejects.toThrow();
  });

  it('rejects a withdrawn instructor entirely, on reads and writes alike', async () => {
    const guard = new ApprovedInstructorGuard(
      buildRepo({ status: MarketplaceInstructorStatus.WITHDRAWN }),
    );
    const { context: readContext } = buildContext('GET', 'user-1');
    await expect(guard.canActivate(readContext)).rejects.toThrow();
    const { context: writeContext } = buildContext('POST', 'user-1');
    await expect(guard.canActivate(writeContext)).rejects.toThrow();
  });

  it('allows an approved instructor to read and to write', async () => {
    const guard = new ApprovedInstructorGuard(buildRepo({ status: MarketplaceInstructorStatus.APPROVED }));
    const { context: readContext } = buildContext('GET', 'user-1');
    await expect(guard.canActivate(readContext)).resolves.toBe(true);
    const { context: writeContext } = buildContext('POST', 'user-1');
    await expect(guard.canActivate(writeContext)).resolves.toBe(true);
  });

  it('allows a suspended instructor to read their own historical records (FR-301)', async () => {
    const guard = new ApprovedInstructorGuard(buildRepo({ status: MarketplaceInstructorStatus.SUSPENDED }));
    for (const method of ['GET', 'HEAD']) {
      const { context } = buildContext(method, 'user-1');
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it('refuses a suspended instructor on every write verb — create, submit, publish, request a payout', async () => {
    const guard = new ApprovedInstructorGuard(buildRepo({ status: MarketplaceInstructorStatus.SUSPENDED }));
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { context } = buildContext(method, 'user-1');
      await expect(guard.canActivate(context)).rejects.toThrow();
    }
  });

  it('attaches the resolved capability row to the request for handlers to reuse, never re-deriving from user.role', async () => {
    const row = { status: MarketplaceInstructorStatus.APPROVED, id: 'instr-1' };
    const guard = new ApprovedInstructorGuard(buildRepo(row));
    const { context, request } = buildContext('GET', 'user-1');
    await guard.canActivate(context);
    expect(request['marketplaceInstructor']).toBe(row);
    expect(request['user']).not.toHaveProperty('role');
  });

  it('an academic teacher with no instructor row is refused — the two capabilities are independent (FR-302)', async () => {
    // The mock repository is keyed purely by user_id lookup; a teacher role
    // on the JWT plays no part in the query, matching FR-302/FR-009: the
    // guard never reads user.role at all.
    const guard = new ApprovedInstructorGuard(buildRepo(null));
    const { context } = buildContext('GET', 'teacher-user-1');
    await expect(guard.canActivate(context)).rejects.toThrow();
  });
});
