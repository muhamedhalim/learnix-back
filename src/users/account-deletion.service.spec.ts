import { AccountDeletionService } from './account-deletion.service';
import { UserRole } from './entities/user-role.enum';

describe('AccountDeletionService', () => {
  it('treats TypeORM PostgreSQL DELETE [rows, rowCount] output as one successful deletion', async () => {
    const manager = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'student-1', name: 'Student', email: 'student@example.test', role: UserRole.STUDENT }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([[{ id: 'student-1' }], 1]),
      getRepository: jest.fn(() => ({ save: jest.fn().mockResolvedValue(undefined) })),
    };
    const dataSource = {
      transaction: jest.fn((work: (entityManager: typeof manager) => unknown) => work(manager)),
      manager,
      getRepository: jest.fn(),
    };
    const service = new AccountDeletionService(dataSource as never);

    await expect(service.permanentlyDelete('student-1', UserRole.STUDENT, 'admin-1')).resolves.toMatchObject({
      deleted: true,
      alreadyDeleted: false,
    });
  });
});
